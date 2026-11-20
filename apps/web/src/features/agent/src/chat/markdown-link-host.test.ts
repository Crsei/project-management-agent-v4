import assert from "node:assert/strict";
import test from "node:test";
import { markdownExternalHost, markdownLinkHostIcon } from "./markdown-link-host.ts";

test("normalizes http(s) hosts for display", () => {
  assert.equal(markdownExternalHost("https://www.GitHub.com/owner/repo"), "github.com");
  assert.equal(markdownExternalHost("  http://example.com./path  "), "example.com");
  assert.equal(markdownExternalHost("https://example.com:8443/a"), "example.com:8443");
  assert.equal(markdownExternalHost("https://example.com:443/a"), "example.com");
  assert.equal(markdownExternalHost("http://example.com:80/a"), "example.com");
  assert.equal(markdownExternalHost("http://localhost:3000/"), "localhost:3000");
});

test("only absolute http(s) URLs get a decorated host", () => {
  assert.equal(markdownExternalHost(undefined), undefined);
  assert.equal(markdownExternalHost(""), undefined);
  assert.equal(markdownExternalHost("mailto:someone@example.com"), undefined);
  assert.equal(markdownExternalHost("#section-2"), undefined);
  assert.equal(markdownExternalHost("/agent/workspace?thread=1"), undefined);
  assert.equal(markdownExternalHost("javascript:alert(1)"), undefined);
  assert.equal(markdownExternalHost("https://example.com/a b"), undefined);
  assert.equal(markdownExternalHost("https://example.com\\a"), undefined);
  assert.equal(markdownExternalHost("https://user:pass@example.com/a"), undefined);
});

test("maps known documentation and code hosts to local icons", () => {
  assert.equal(markdownLinkHostIcon("github.com"), "code");
  assert.equal(markdownLinkHostIcon("gist.github.com"), "code");
  assert.equal(markdownLinkHostIcon("gitlab.com"), "code");
  assert.equal(markdownLinkHostIcon("www.npmjs.com"), "package");
  assert.equal(markdownLinkHostIcon("developer.mozilla.org"), "book");
  assert.equal(markdownLinkHostIcon("docs.example.readthedocs.io"), "book");
  assert.equal(markdownLinkHostIcon("youtu.be"), "video");
  assert.equal(markdownLinkHostIcon("stackoverflow.com"), "discussion");
  assert.equal(markdownLinkHostIcon("arxiv.org"), "document");
});

test("unknown hosts and ports fall back to the generic external icon", () => {
  assert.equal(markdownLinkHostIcon("example.com"), "external");
  assert.equal(markdownLinkHostIcon("example.com:8443"), "external");
  assert.equal(markdownLinkHostIcon(undefined), "external");
  assert.equal(markdownLinkHostIcon("notgithub.com"), "external");
});
