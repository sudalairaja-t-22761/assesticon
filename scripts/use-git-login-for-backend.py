#!/usr/bin/env python3
"""
Copy the ZohoRepository login that your own git already uses (macOS Keychain via
`git credential fill`) into the spriteForgeJoin env files as REPO_TOKEN, ICON_REPO_TOKEN,
REPO_TOKEN_USER and ICON_REPO_TOKEN_USER. The secret is never printed.

Usage (from anywhere):
  python3 scripts/use-git-login-for-backend.py               # local backend (.env)
  python3 scripts/use-git-login-for-backend.py --production  # also .env.production (deployed); then redeploy
"""
import sys
import os
import re
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FN = os.path.join(ROOT, "functions", "spriteForgeJoin")
TARGETS = [".env"] + ([".env.production"] if "--production" in sys.argv else [])
QUERY = "protocol=https\nhost=zrepository.zohocorpcloud.in\npath=zohocorp/CRM/CRM_UI/CRM_UI_LIBRARY.git\n\n"

out = subprocess.run(["git", "credential", "fill"], input=QUERY, capture_output=True, text=True,
                     env={**os.environ, "GIT_TERMINAL_PROMPT": "0"}).stdout
cred = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
user, secret = cred.get("username", ""), cred.get("password", "")
if not secret:
    raise SystemExit("No saved git login found for zrepository.zohocorpcloud.in (check Keychain Access).")

values = (("REPO_TOKEN", secret), ("ICON_REPO_TOKEN", secret),
          ("REPO_TOKEN_USER", user or "oauth2"), ("ICON_REPO_TOKEN_USER", user or "oauth2"))
for name in TARGETS:
    path = os.path.join(FN, name)
    text = open(path).read()
    for key, value in values:
        if re.search(r"(?m)^%s=" % key, text):
            text = re.sub(r"(?m)^%s=.*$" % key, lambda m, k=key, v=value: k + "=" + v, text)
        else:
            text = text.rstrip("\n") + "\n%s=%s\n" % (key, value)
    open(path, "w").write(text)
    print("Updated %s with your git login (username: %s, secret length: %d)." % (name, user or "oauth2", len(secret)))
if "--production" in sys.argv:
    print("Now redeploy so production gets it:  catalyst deploy --only functions:spriteForgeJoin")
else:
    print("The backend restarts by itself; check in 5 s with:")
    print("  curl -s localhost:3001/api/icon-library/diagnose | grep -o '\"hint\":\"[^\"]*\"'")
