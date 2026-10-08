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
