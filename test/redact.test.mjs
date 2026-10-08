import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSensitive, boundedText } from "../redact.js";

/**
 * The redaction boundary is the only rewrite a command text goes through before
 * it reaches the judge, the audit log and the denial feedback. A rewrite that
 * deletes text a rule keys on is a security defect, not a cosmetic one, so both
 * directions are pinned here: secrets must go, structure must stay.
 */

test("redactSensitive: a credential does not swallow the rest of the line", () => {
	// Regression: `[^\s,;]+` ate everything after `|`/`&`, so
	// `token=Z|git reset --hard HEAD` lost its `git` and the deny rule never
	// matched. The value now stops at the separator.
	const out = redactSensitive("echo hi token=Z|git reset --hard HEAD");
	assert.equal(out, "echo hi token=[REDACTED]|git reset --hard HEAD");
	assert.ok(out.includes("git reset --hard HEAD"));
});

test("redactSensitive: URL query redaction keeps later parameters", () => {
	assert.equal(
		redactSensitive("curl -s \"https://api.x.com/v1?api_key=AAA&access_token=BBB&page=2\""),
		"curl -s \"https://api.x.com/v1?api_key=[REDACTED]&access_token=[REDACTED]&page=2\""
	);
});

test("redactSensitive: comma-separated assignments do not eat their neighbours", () => {
	assert.equal(redactSensitive("A=1,password=x,B=2"), "A=1,password=[REDACTED],B=2");
});

test("redactSensitive: a quoted value is redacted whole, tail included", () => {
	// `password='alpha beta'` used to leave `beta'` in the clear.
	const out = redactSensitive("mysql --password='alpha beta' db");
	assert.equal(out, "mysql --password=[REDACTED] db");
	assert.ok(!out.includes("beta"));
});

test("redactSensitive: the pre-existing shapes still redact", () => {
	assert.equal(redactSensitive("K=sk-livekey1234567890"), "K=[REDACTED]");
	assert.equal(redactSensitive("export TOKEN=\"abc\""), "export TOKEN=[REDACTED]");
	assert.equal(redactSensitive("curl -H \"Authorization: Bearer xyz789\""), "curl -H \"Authorization: Bearer [REDACTED]\"");
	assert.equal(redactSensitive("https://h/?token=abc"), "https://h/?token=[REDACTED]");
});

test("redactSensitive: an escaped separator stays inside the value", () => {
	// `password=alpha\|beta` is ONE shell value (`|` escaped). Stopping at the
	// backslash leaked the tail; only an unescaped separator ends the value.
	assert.equal(redactSensitive("mysql -p password=alpha\\|beta"), "mysql -p password=[REDACTED]");
	assert.equal(redactSensitive("run --password=alpha\\|beta --next"), "run --password=[REDACTED] --next");
});

test("redactSensitive: an escaped quote does not end a quoted value", () => {
	assert.equal(redactSensitive("mysql --password='a\\'b secret' db"), "mysql --password=[REDACTED] db");
});

test("redactSensitive: non-strings pass through unchanged", () => {
	assert.equal(redactSensitive(undefined), undefined);
	assert.equal(redactSensitive(null), null);
	assert.equal(redactSensitive(42), 42);
});

test("boundedText: redacts, trims, then bounds", () => {
	assert.equal(boundedText("  token=abc  ", 100), "token=[REDACTED]");
	assert.equal(boundedText("   ", 100), undefined);
	assert.equal(boundedText("abcdefghij", 5), "abcd…");
});

test("redactSensitive: environment-style names are whole keys, not `\\b`-prefixed words", () => {
	// `_` is a word character, so a bare `\b` in front of the keyword never
	// matched these — 10 of 12 common shapes leaked through the old pattern.
	assert.equal(redactSensitive("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI aws s3 ls"), "AWS_SECRET_ACCESS_KEY=[REDACTED] aws s3 ls");
	assert.equal(redactSensitive("env AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE cmd"), "env AWS_ACCESS_KEY_ID=[REDACTED] cmd");
	assert.equal(redactSensitive("export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "export GITHUB_TOKEN=[REDACTED]");
	assert.equal(redactSensitive("npm config set //registry.npmjs.org/:_authToken=npm_9aBcDeFgHiJkLmNoPqRs"), "npm config set //registry.npmjs.org/:_authToken=[REDACTED]");
	assert.equal(redactSensitive("K=sk-livekey1234567890"), "K=[REDACTED]");
});

test("redactSensitive: authentication headers keep the scheme and lose the credential", () => {
	// `Bearer` used to be the only scheme handled, so a Basic header came out as
	// `Authorization: [REDACTED] <b64>` — the label blacked out and the
	// credential (base64 of `user:password`) in the clear.
	assert.equal(redactSensitive('curl -H "Authorization: Basic dXNlcjpwYXNz" https://x'), 'curl -H "Authorization: Basic [REDACTED]" https://x');
	assert.equal(redactSensitive('curl -H "Authorization: token ghp_abcdefghijklmnopqrstuvwxyz" https://x'), 'curl -H "Authorization: token [REDACTED]" https://x');
	assert.equal(redactSensitive('curl -H "Proxy-Authorization: Basic YWRtaW46aHVudGVyMg==" https://x'), 'curl -H "Proxy-Authorization: Basic [REDACTED]" https://x');
	// A header with no scheme at all still loses its value.
	assert.equal(redactSensitive('curl -H "Authorization: xyz789abc" https://x'), 'curl -H "Authorization: [REDACTED]" https://x');
	// …and the scheme is not eaten twice.
	assert.equal(redactSensitive('curl -H "Authorization: Bearer xyz" https://x'), 'curl -H "Authorization: Bearer [REDACTED]" https://x');
});

test("redactSensitive: URL userinfo loses the credential but KEEPS the host", () => {
	// The host is a clue the judge needs, and `command-facts.js` reads it from
	// this same redacted text — which is why the URL placeholder carries no
	// brackets (they broke the authority, and the host came out as `redacted`).
	assert.equal(redactSensitive("git clone https://oauth2:glpat-abc123XYZ@gitlab.internal/x.git"), "git clone https://REDACTED@gitlab.internal/x.git");
	assert.equal(redactSensitive("psql postgres://app:s3cr3tPass@db.internal/prod"), "psql postgres://REDACTED@db.internal/prod");
	assert.equal(redactSensitive("curl -u admin:hunter2 https://x"), "curl -u [REDACTED] https://x");
	// A URL with no userinfo is left exactly as written.
	assert.equal(redactSensitive("curl https://gitlab.internal/x"), "curl https://gitlab.internal/x");
});

test("redactSensitive: credential shapes that carry no label at all", () => {
	assert.equal(redactSensitive("printf '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----'"), "printf '[REDACTED PRIVATE KEY]'");
	assert.equal(redactSensitive(`slack --webhook ${["xoxb", "123456789012", "abcdefghijklmnop"].join("-")} hook`), "slack --webhook [REDACTED] hook");
	assert.equal(redactSensitive("export T=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSM e"), "export T=[REDACTED] e");
	assert.equal(redactSensitive("env KEY=AKIAIOSFODNN7EXAMPLE cmd"), "env KEY=[REDACTED] cmd");
});
