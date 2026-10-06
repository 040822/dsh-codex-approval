#!/usr/bin/env node
/**
 * dsh-codex-approval — 在**每一个可发现的 schemastery 平面**上跑一遍单测。
 *
 * 为什么要它：插件通过 `link:` 装进 profile，而 Node 解析 bare specifier 时会对
 * 软链做 realpath，落到插件目录的**真实路径**上，从那里往上找 `node_modules`。
 * profile 平面（`$DSH_HOME/profiles/node_modules`）不是这条祖先链上的一环 ——
 * 2026-09-30 实测：移除插件私有的 `@deepseek-ai/schemastery` 软链后，插件里
 * `import z from "@deepseek-ai/schemastery"` 直接 ERR_MODULE_NOT_FOUND。
 *
 * 所以「插件拿到哪份 schemastery」完全由插件目录里那条软链决定，与 $DSH_HOME
 * 无关。0.1.5（3.18.2，无 `.volatile()`）与 0.2.0（3.18.4，有）并存期间，同一份
 * 源码必须在两种平面上都过，而软链一次只能指一个 —— 本脚本把这件事变成显式、
 * 可重复的一步：把源码复制到临时目录，把 schemastery 挂成目标平面，跑探针再跑
 * `node --test`。两种平面各跑一遍，都不碰插件目录里那条软链。
 *
 * 注意文件名：**不能**以 `test-` 开头 —— `node --test` 的文件发现规则会匹配
 * `test-*.mjs`，把它当测试文件收集进来，于是它自己调自己的 `node --test` 递归。
 * 所以这里叫 check-planes.mjs。
 *
 * 用法（在包根目录）：
 *   node scripts/check-planes.mjs [插件源码目录]
 *
 * 追加/覆盖平面：
 *   EXTRA_SCHEMASTER=/path/a;/path/b   # 额外纳入的平面目录
 *   PROD_SCHEMASTER / PREVIEW_SCHEMASTER  # 覆盖默认发现结果
 *
 * 退出码非零表示：某个平面有失败用例，或探针与用例结果自相矛盾
 * （volatile 可用却没跑 volatile 往返、volatile 不可用却没跳过）。
 */
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

const HOME = homedir();
const SRC = resolve(process.argv[2] ?? join(import.meta.dirname, ".."));
/**
 * 期待被跳过的用例数：test/index.test.mjs 里标记 `VOLATILE_ONLY` 的用例条数 ——
 * 3 条纯 volatile 语义的配置往返 + 1 条「默认审批模式热生效」。
 * 新增 VOLATILE_ONLY 用例时同步这个数字，否则无 volatile 的平面会误报。
 */
const EXPECTED_SKIPS_WITHOUT_VOLATILE = 4;
const SKIP_DIRS = new Set(["node_modules", ".git", ".pnpm"]);

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", b: "\x1b[1m", x: "\x1b[0m" };
const say = (s = "") => process.stdout.write(`${s}\n`);

async function copyTree(from, to) {
	await mkdir(to, { recursive: true });
	for (const e of await readdir(from, { withFileTypes: true })) {
		if (SKIP_DIRS.has(e.name)) continue;
		const s = join(from, e.name);
		const d = join(to, e.name);
		if (e.isDirectory()) await copyTree(s, d);
		else if (e.isFile()) await cp(s, d);
	}
}

function versionOf(dir) {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
	} catch {
		return null;
	}
}

/** 能挂成平面的 schemastery 目录：全局安装、槽位安装、插件自己的 pnpm 实体。 */
function discoverPlanes() {
	const found = [];
	const push = (p) => {
		if (!p) return;
		const dir = resolve(p);
		if (existsSync(join(dir, "package.json"))) found.push(dir);
	};
	push(process.env.PROD_SCHEMASTER);
	push(process.env.PREVIEW_SCHEMASTER);
	for (const p of (process.env.EXTRA_SCHEMASTER ?? "").split(";")) push(p.trim());

	push(join(HOME, ".npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery"));
	const runtimes = join(HOME, "dsh-runtimes");
	if (existsSync(runtimes)) {
		for (const d of readdirSync(runtimes)) {
			push(join(runtimes, d, "node_modules/@deepseek-ai/schemastery"));
		}
	}
	const pnpm = join(SRC, "node_modules/.pnpm");
	if (existsSync(pnpm)) {
		for (const d of readdirSync(pnpm)) {
			if (d.startsWith("@deepseek-ai+schemastery@")) {
				push(join(pnpm, d, "node_modules/@deepseek-ai/schemastery"));
			}
		}
	}
	// 按版本去重，同名版本保留第一个（后面的只是同一份包的不同副本）
	const byVersion = new Map();
	for (const dir of found) {
		const v = versionOf(dir);
		if (v && !byVersion.has(v)) byVersion.set(v, dir);
	}
	return [...byVersion.entries()].map(([version, dir]) => ({ version, dir }));
}

const PROBE = `
const z = (await import("@deepseek-ai/schemastery")).default;
console.log(JSON.stringify({
	resolved: import.meta.resolve("@deepseek-ai/schemastery"),
	volatile: typeof z?.string?.().volatile === "function"
}));
`;

async function runPlane({ version, dir }) {
	const tmp = await mkdtemp(join(tmpdir(), `dsh-codex-approval-plane-${version}-`));
	try {
		await copyTree(SRC, tmp);
		await mkdir(join(tmp, "node_modules/@deepseek-ai"), { recursive: true });
		await symlink(dir, join(tmp, "node_modules/@deepseek-ai/schemastery"));
		await writeFile(join(tmp, "plane-probe.mjs"), PROBE);

		const probeRun = spawnSync(process.execPath, ["plane-probe.mjs"], { cwd: tmp, encoding: "utf8" });
		let probe = null;
		try {
			probe = JSON.parse(probeRun.stdout.trim().split("\n").pop());
		} catch {
			say(`  ${c.r}探针失败${c.x}：${(probeRun.stderr || probeRun.stdout).trim().split("\n")[0]}`);
			return { version, ok: false };
		}

		const testRun = spawnSync(process.execPath, ["--test", "--test-reporter=tap"], {
			cwd: tmp,
			encoding: "utf8"
		});
		const num = (k) => {
			const m = new RegExp(`^# ${k} (\\d+)$`, "m").exec(testRun.stdout ?? "");
			return m ? Number(m[1]) : -1;
		};
		const tests = num("tests");
		const pass = num("pass");
		const fail = num("fail");
		const skipped = num("skipped");

		say(`  schemastery ${version}  ${dim(dir)}`);
		say(`  解析命中  ${dim(probe.resolved.replace("file://", ""))}`);
		say(`  volatile  ${probe.volatile ? `${c.g}可用${c.x}（字段是 cosmokit 引用，改配置不重载）` : `${c.y}不可用${c.x}（字段是普通值，改配置需重载）`}`);
		say(`  单测      tests=${tests} pass=${pass} fail=${fail} skipped=${skipped}`);

		const problems = [];
		if (tests < 0) problems.push("拿不到 TAP 统计（测试进程可能没跑起来）");
		if (fail !== 0) problems.push(`有 ${fail} 个失败用例`);
		if (probe.volatile && skipped !== 0) problems.push(`volatile 可用却跳过了 ${skipped} 条——探测与用例不一致`);
		if (!probe.volatile && skipped === 0)
			problems.push("volatile 不可用却一条都没跳过——平面没挂对，或测试丢失了平面感知");
		if (!probe.volatile && skipped !== EXPECTED_SKIPS_WITHOUT_VOLATILE && skipped > 0)
			problems.push(`跳过数为 ${skipped}，预期 ${EXPECTED_SKIPS_WITHOUT_VOLATILE}`);

		for (const p of problems) say(`  ${c.r}✗ ${p}${c.x}`);
		if (!problems.length) say(`  ${c.g}✓ 通过${c.x}`);
		return { version, ok: problems.length === 0 };
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const planes = discoverPlanes();
say(`${c.b}dsh-codex-approval 双平面单测${c.x}`);
say(`插件源码  ${SRC}`);
say(`发现平面  ${planes.length} 个：${planes.map((p) => p.version).join(", ") || "(无)"}`);
say("");
if (!planes.length) {
	say(`${c.r}一个平面都没发现${c.x}：检查 ~/.npm-global 与 ~/dsh-runtimes 下的 dsh 安装，或用 EXTRA_SCHEMASTER 指定。`);
	process.exit(1);
}

const results = [];
for (const plane of planes) {
	results.push(await runPlane(plane));
	say("");
}

const bad = results.filter((r) => !r.ok);
if (bad.length) {
	say(`${c.r}${bad.length}/${results.length} 个平面未通过${c.x}：${bad.map((r) => r.version).join(", ")}`);
	process.exit(1);
}
say(`${c.g}全部通过${c.x}（${results.length} 个平面：${results.map((r) => r.version).join(", ")}）`);
