#!/usr/bin/env python3
"""
Turn on the npm release for the deployed backend: copy the cm-npmregistry login that your own npm already uses
(~/.npmrc "//cm-npmregistry/:_authToken=...") into functions/spriteForgeJoin/.env.production as REPO_NPM_TOKEN,
and set REPO_NPM_PUBLISH=true and REPO_NPM_REGISTRY. The master branch (MASTER_REPO_*) uses the same values.
The token is never printed.

Usage (from anywhere):
  python3 scripts/use-npm-login-for-backend.py           # then redeploy the function
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, "functions", "spriteForgeJoin", ".env.production")
REGISTRY_HOST = "cm-npmregistry"
REGISTRY = "http" + "://" + REGISTRY_HOST

npmrc = os.path.expanduser("~/.npmrc")
token = ""
if os.path.exists(npmrc):
    for line in open(npmrc):
        m = re.match(r"\s*//%s/?:_authToken\s*=\s*(\S+)" % re.escape(REGISTRY_HOST), line)
        if m:
            token = m.group(1).strip().strip('"')
if not token:
    raise SystemExit("No cm-npmregistry login found in ~/.npmrc. Run:  npm login --registry %s  and try again." % REGISTRY)
if token.startswith("${"):
    raise SystemExit("~/.npmrc refers to an environment variable for the token; put the real token in REPO_NPM_TOKEN by hand.")

values = (("REPO_NPM_PUBLISH", "true"), ("REPO_NPM_REGISTRY", REGISTRY), ("REPO_NPM_TOKEN", token))
text = open(TARGET).read() if os.path.exists(TARGET) else ""
for key, value in values:
    if re.search(r"(?m)^%s=" % key, text):
        text = re.sub(r"(?m)^%s=.*$" % key, lambda m, k=key, v=value: k + "=" + v, text)
    else:
        text = text.rstrip("\n") + "\n%s=%s\n" % (key, value)
open(TARGET, "w").write(text)
print("Updated .env.production: REPO_NPM_PUBLISH=true, REPO_NPM_REGISTRY=%s, REPO_NPM_TOKEN set (length %d)." % (REGISTRY, len(token)))
print("Now redeploy:  npm run deploy")
print("Then check:    curl -s '<function url>/api/master-library/diagnose?npm=1'  (look at \"release\")")
