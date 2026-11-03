"""Author reviewed dual-source adaptations; does not run acceptance checks or source code."""
import argparse
import base64
import difflib
import hashlib
import json
import re
import subprocess
from pathlib import Path, PurePosixPath


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_file(root, relative):
    if not isinstance(relative, str) or not relative or "\\" in relative or "\0" in relative:
        raise ValueError(f"Unsafe path: {relative}")
    if PurePosixPath(relative).is_absolute() or any(p in ("", ".", "..") for p in relative.split("/")):
        raise ValueError(f"Unsafe path: {relative}")
    current = root
    for part in relative.split("/"):
        current /= part
        if current.is_symlink():
            raise ValueError(f"Symlink refused: {relative}")
    return current


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source", required=True)
args = parser.parse_args()
vendor = Path(__file__).resolve().parent.parent
root = vendor.parent.parent
ledger_path = vendor / "mcp-skills-adaptations.json"
ledger = json.loads(ledger_path.read_bytes())
source = Path(args.source).resolve(strict=True)
originals = {}
for identity in ledger["sources"]:
    commit = identity["commit"]
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", f"{commit}^{{commit}}"], text=True).strip()
    if actual != commit:
        raise ValueError(f"Wrong source identity: {commit}")
    license_bytes = subprocess.check_output(["git", "-C", str(source), "show", f"{commit}:LICENSE"])
    identity["license"] = {"spdx": "MIT", "path": "LICENSE", "sha256": digest(license_bytes), "distributedPath": "vendor/t3code/LICENSE"}
    if license_bytes != (vendor / "LICENSE").read_bytes():
        raise ValueError("Distributed MIT notice differs from pinned source")
known_commits = {s["commit"] for s in ledger["sources"]}
seen = set()
for output in ledger["outputs"]:
    target = output["destination"]
    if target in seen:
        raise ValueError(f"Duplicate output: {target}")
    seen.add(target)
    file = safe_file(root, target)
    after = file.read_bytes()
    output.update(sha256=digest(after), bytes=len(after), mode=0o755 if file.stat().st_mode & 0o111 else 0o644)
    inputs = output.get("inputs", [])
    if bool(inputs) != (output["provenance"] == "adapted-upstream"):
        raise ValueError(f"Source classification mismatch: {target}")
    for item in inputs:
        if item["commit"] not in known_commits:
            raise ValueError(f"Unknown commit: {target}")
        safe_file(source, item["path"])
        key = (item["commit"], item["path"])
        if key not in originals:
            originals[key] = subprocess.check_output(["git", "-C", str(source), "show", f"{key[0]}:{key[1]}"])
        data = originals[key]
        item.update(sha256=digest(data), bytes=len(data), gitBlobSha1=hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest())
        item["gitMode"] = subprocess.check_output(["git", "-C", str(source), "ls-tree", item["commit"], "--", item["path"]], text=True).split()[0]
    if inputs:
        before = originals[(inputs[0]["commit"], inputs[0]["path"])]
        old_lines = re.findall(r"[^\n]*\n|[^\n]+$", before.decode("utf8"))
        new_lines = re.findall(r"[^\n]*\n|[^\n]+$", after.decode("utf8"))
        output["recipe"] = {"kind": "exact-line-splices", "primaryInput": 0, "splices": [
            {"start": i, "before": old_lines[i:j], "after": new_lines[k:l]}
            for operation, i, j, k, l in difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False).get_opcodes()
            if operation != "equal"
        ]}
    else:
        output["recipe"] = {"kind": "local-bytes", "base64": base64.b64encode(after).decode("ascii")}
ledger["outputs"].sort(key=lambda item: item["destination"])
data = (json.dumps(ledger, ensure_ascii=False, indent=2) + "\n").encode()
if ledger_path.read_bytes() != data:
    ledger_path.write_bytes(data)
print(json.dumps({"operation": "reviewed-authoring-only", "sources": len(known_commits), "outputs": len(seen)}))
