"""Author explicitly reviewed dual-source adaptations; never run source code or checks."""
import argparse
import base64
import copy
import difflib
import hashlib
import json
import re
import stat
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
    for index, part in enumerate(relative.split("/")):
        current /= part
        if current.is_symlink() or (current.exists() and index < len(relative.split("/")) - 1 and not current.is_dir()):
            raise ValueError(f"Symlink/non-directory refused: {relative}")
    return current


def requests(values, root, label, hashes=False):
    result = {}
    for value in values:
        name, separator, approval = value.partition("=")
        safe_file(root, name)
        if not separator or not approval.strip() or name in result:
            raise ValueError(f"Incomplete/duplicate {label}: {name}")
        if hashes and not re.fullmatch(r"[a-f0-9]{64}", approval):
            raise ValueError(f"Invalid {label} SHA256: {name}")
        result[name] = approval
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--accept-output", action="append", default=[], metavar="PATH=SHA256", help="Exact reviewed current hash for each changed, non-retired output.")
    parser.add_argument("--retire-output", action="append", default=[], metavar="PATH=OLD_SHA256", help="Explicit retirement of an absent output, preserving its complete old record.")
    parser.add_argument("--retirement-reason", action="append", default=[], metavar="PATH=REASON", help="Required explicit rationale for the matching retirement request.")
    args = parser.parse_args()
    vendor = Path(__file__).resolve().parent.parent
    root = vendor.parent.parent
    ledger_path = safe_file(root, "vendor/t3code/mcp-skills-adaptations.json")
    old_bytes = ledger_path.read_bytes()
    ledger = json.loads(old_bytes)
    inventory_path = safe_file(root, "vendor/t3code/sync-inventory.json")
    inventory_bytes = inventory_path.read_bytes()
    inventory = json.loads(inventory_bytes)
    bindings = [item for item in inventory["files"] if item["destination"] == "vendor/t3code/mcp-skills-adaptations.json"]
    if (inventory.get("upstreamCommit") != ledger.get("baselineCommit") or len(bindings) != 1
            or bindings[0].get("asset") != "vendor/t3code/mcp-skills-adaptations.json"
            or bindings[0].get("sha256") != digest(old_bytes) or bindings[0].get("bytes") != len(old_bytes)):
        raise ValueError("Prior adaptation ledger differs from its recorded baseline; do not hand-edit records or recapture around review")
    source = Path(args.source).resolve(strict=True)
    accepted = requests(args.accept_output, root, "output acceptance", hashes=True)
    retired = requests(args.retire_output, root, "retirement", hashes=True)
    reasons = requests(args.retirement_reason, root, "retirement rationale")
    if retired.keys() != reasons.keys() or retired.keys() & accepted.keys():
        raise ValueError("Every retirement requires exactly one rationale and cannot also accept live bytes")
    outputs = {item["destination"]: item for item in ledger["outputs"]}
    unknown = (accepted.keys() | retired.keys() | reasons.keys()) - outputs.keys()
    if unknown:
        raise ValueError(f"Unknown output requests: {sorted(unknown)}")

    # Reconstruct and verify EVERY old recipe, source hash/blob/size/mode and MIT
    # identity before authoring anything. The replay helper never runs source code.
    # In particular, do not repair immutable identities by hashing new originals.
    subprocess.run([
        "node", "--input-type=module", "-e",
        'import {readFile} from "node:fs/promises"; import {pathToFileURL} from "node:url"; '
        'const [root,source,helper]=process.argv.slice(1); '
        'const {replayMcpSkillsAdaptations}=await import(pathToFileURL(helper)); '
        'await replayMcpSkillsAdaptations(root,source,JSON.parse(await readFile(root+"/vendor/t3code/mcp-skills-adaptations.json","utf8")));',
        str(root), str(source), str(vendor / "scripts/mcp-skills-adaptations.mjs"),
    ], check=True)
    updated = copy.deepcopy(ledger)
    for output in updated["outputs"]:
        target = output["destination"]
        file = safe_file(root, target)
        if "retirement" in output:
            if target in retired or target in accepted:
                raise ValueError(f"Output already retired: {target}")
            if file.exists():
                raise ValueError(f"Retired target exists: {target}")
            continue
        if target in retired:
            if file.exists():
                raise ValueError(f"Retirement target still exists: {target}")
            if retired[target] != output["sha256"]:
                raise ValueError(f"Retirement preimage hash mismatch: {target}")
            output["retirement"] = {"sha256": retired[target], "reason": reasons[target]}
            continue
        info = file.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o7000:
            raise ValueError(f"Unsafe output file: {target}")
        after = file.read_bytes()
        sha256 = digest(after)
        mode = 0o755 if info.st_mode & 0o111 else 0o644
        if mode != output["mode"]:
            raise ValueError(f"Output mode changes require a separate review: {target}")
        changed = sha256 != output["sha256"] or len(after) != output["bytes"]
        if changed and accepted.get(target) != sha256:
            raise ValueError(f"Unapproved output drift; require --accept-output {target}={sha256}")
        if target in accepted and (not changed or accepted[target] != sha256):
            raise ValueError(f"Stale/unnecessary output acceptance: {target}")
        if not changed:
            continue
        output.update(sha256=sha256, bytes=len(after))
        inputs = output["inputs"]
        if inputs:
            primary = inputs[0]
            before = subprocess.check_output(["git", "-C", str(source), "show", f'{primary["commit"]}:{primary["path"]}'])
            old_lines = re.findall(r"[^\n]*\n|[^\n]+$", before.decode("utf8"))
            new_lines = re.findall(r"[^\n]*\n|[^\n]+$", after.decode("utf8"))
            output["recipe"] = {"kind": "exact-line-splices", "primaryInput": 0, "splices": [
                {"start": i, "before": old_lines[i:j], "after": new_lines[k:l]}
                for operation, i, j, k, l in difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False).get_opcodes()
                if operation != "equal"
            ]}
        else:
            output["recipe"] = {"kind": "local-bytes", "base64": base64.b64encode(after).decode("ascii")}

    # The existing import authority checks current host consumers, including files
    # outside the adaptation allowlist. It reads the proposed ledger from stdin;
    # rejection cannot leave metadata or temporary recipe files behind.
    subprocess.run(["node", str(vendor / "scripts/imports.mjs"), "--check-retirements"], input=json.dumps(updated).encode(), check=True)
    updated["outputs"].sort(key=lambda item: item["destination"])
    data = (json.dumps(updated, ensure_ascii=False, indent=2) + "\n").encode()
    if ledger_path.read_bytes() != old_bytes or inventory_path.read_bytes() != inventory_bytes:
        raise ValueError("Adaptation ledger/baseline changed during authoring; refusing publication")
    if data != old_bytes:
        ledger_path.write_bytes(data)
    print(json.dumps({"operation": "reviewed-authoring-only", "sources": len(updated["sources"]), "outputs": len(outputs), "retired": sum("retirement" in item for item in updated["outputs"])}))


if __name__ == "__main__":
    main()
