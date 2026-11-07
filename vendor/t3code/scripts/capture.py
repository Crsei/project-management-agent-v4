"""Recapture reviewed, same-commit adaptations; never copy source trees or run code.

This is an explicit maintainer authoring operation, not an acceptance check. New
local additions must first be added to the allowlist in sync-inventory.json.
"""
import argparse
import difflib
import hashlib
import json
import re
from pathlib import Path, PurePosixPath
import subprocess


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def safe_file(root, relative):
    if not isinstance(relative, str) or not relative or "\\" in relative or "\0" in relative:
        raise ValueError(f"Unsafe path: {relative}")
    parts = relative.split("/")
    if PurePosixPath(relative).is_absolute() or any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"Unsafe path: {relative}")
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"Symlink input/output refused: {relative}")
    return current


def publish(target, data):
    # Identical captures do not touch file bytes or timestamps.
    if target.is_file() and target.read_bytes() == data:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source", required=True)
parser.add_argument("--review-actions", action="store_true", help="Explicitly authorize updating copy-verbatim/copy-then-patch dispositions only; immutable source metadata is never changed.")
parser.add_argument("--allow-local", action="append", default=[], help="Explicit reviewed vendor metadata/local addition to enroll; never use for adapted upstream modules.")
parser.add_argument("--allow-host-input", action="append", default=[], help="Explicit reviewed host build tool/configuration to enroll; hashes are calculated only during this authoring operation.")
arguments = parser.parse_args()
vendor = Path(__file__).resolve().parent.parent
repository = vendor.parent.parent
source = Path(arguments.source).resolve(strict=True)
manifest_bytes = (vendor / "source-manifest.json").read_bytes()
manifest = json.loads(manifest_bytes)
inventory = json.loads((vendor / "sync-inventory.json").read_bytes())
commit = manifest["upstream"]["commit"]
head = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
if head != commit or inventory["upstreamCommit"] != commit:
    raise ValueError("Wrong source commit; a different upstream requires a separately reviewed manifest.")
originals = {}
for entry in manifest["files"]:
    data = safe_file(source, entry["source_path"]).read_bytes()
    blob = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
    if digest(data) != entry["sha256"] or blob != entry["git_blob_sha1"] or len(data) != entry["bytes"]:
        raise ValueError(f"Wrong immutable source hash/blob: {entry['source_path']}")
    originals[entry["source_path"]] = data

recipes = []
patches = {}
for entry in manifest["files"]:
    if not entry["action"].startswith("copy"):
        continue
    destination = entry["destination_path"]
    if not destination.startswith("vendor/t3code/"):
        raise ValueError(f"Outside owned source tree: {destination}")
    target = safe_file(repository, destination)
    before = originals[entry["source_path"]]
    after = target.read_bytes()
    changed = before != after
    expected_action = "copy-then-patch" if changed else "copy-verbatim"
    if entry["action"] != expected_action:
        if not arguments.review_actions:
            raise ValueError(f"Review source-manifest action before recapture: {entry['source_path']} -> {expected_action}")
        entry["action"] = expected_action
    recipe = {
        "destination": destination,
        "source": entry["source_path"],
        "upstreamSha256": entry["sha256"],
        "sha256": digest(after),
        "bytes": len(after),
        "mode": 0o755 if target.stat().st_mode & 0o111 else 0o644,
        "provenance": "patched-upstream" if changed else "pristine-upstream",
    }
    if changed:
        old_lines = re.findall(r"[^\n]*\n|[^\n]+$", before.decode("utf8"))
        new_lines = re.findall(r"[^\n]*\n|[^\n]+$", after.decode("utf8"))
        splices = [
            {"start": i, "before": old_lines[i:j], "after": new_lines[k:l]}
            for operation, i, j, k, l in difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False).get_opcodes()
            if operation != "equal"
        ]
        patch_path = "vendor/t3code/integration-patches/" + entry["source_path"] + ".json"
        patch_bytes = encoded({
            "version": 1,
            "source": entry["source_path"],
            "beforeSha256": digest(before),
            "afterSha256": digest(after),
            "format": "Exact zero-based original-line splices; no offsets or fuzz. Lines include original terminators.",
            "rationaleLedgers": ["vendor/t3code/integration-patches.json"] + [
                "vendor/t3code/" + name for name in manifest["implementation_inventory"]["family_ledgers"]
            ],
            "splices": splices,
        })
        patches[patch_path] = patch_bytes
        recipe["patch"] = {"path": patch_path, "sha256": digest(patch_bytes)}
    recipes.append(recipe)

selected = {entry["destination"] for entry in recipes}
for relative in arguments.allow_local:
    if not relative.startswith("vendor/t3code/") or relative in selected:
        raise ValueError(f"Invalid local addition: {relative}")
    safe_file(repository, relative)
    if not any(entry["destination"] == relative for entry in inventory["files"]):
        inventory["files"].append({
            "destination": relative, "asset": relative, "mode": 0o644,
            "provenance": "local-addition", "rationaleLedger": "vendor/t3code/integration-patches.json",
        })
assets = {}
for old in inventory["files"]:
    if "asset" not in old or old["destination"] in selected or old["destination"].startswith("vendor/t3code/integration-patches/"):
        continue
    if old["asset"] != old["destination"] or not old["asset"].startswith("vendor/t3code/"):
        raise ValueError(f"Outside explicit local-asset allowlist: {old['destination']}")
    assets[old["destination"]] = dict(old)
for relative, data in patches.items():
    assets[relative] = {
        "destination": relative, "asset": relative, "sha256": digest(data), "bytes": len(data),
        "mode": 0o644, "provenance": "local-addition", "rationaleLedger": "vendor/t3code/integration-patches.json",
    }
for relative, entry in sorted(assets.items()):
    target = safe_file(repository, relative)
    data = patches[relative] if relative in patches else target.read_bytes()
    entry.update(sha256=digest(data), bytes=len(data))
    recipes.append(entry)

adaptation_path = vendor / "mcp-skills-adaptations.json"
if adaptation_path.is_file():
    supplemental = json.loads(adaptation_path.read_bytes())
    subprocess.run([
        "node", "--input-type=module", "-e",
        'import {pathToFileURL} from "node:url"; import {readFileSync} from "node:fs"; '
        'const [root,helper]=process.argv.slice(1); '
        'const {validateAdaptationManifest,assertRetiredTargetsAbsent}=await import(pathToFileURL(helper)); '
        'await assertRetiredTargetsAbsent(root,validateAdaptationManifest(JSON.parse(readFileSync(0,"utf8"))));',
        str(repository), str(vendor / "scripts/mcp-skills-adaptations.mjs"),
    ], input=json.dumps(supplemental).encode(), check=True)
    for entry in supplemental["outputs"]:
        destination = entry["destination"]
        if "retirement" in entry:
            if destination in selected or destination in assets:
                raise ValueError(f"Retired output retains another reconstruction owner: {destination}")
            if safe_file(repository, destination).exists():
                raise ValueError(f"Retired target exists: {destination}")
            continue
        if destination in selected or not destination.startswith("vendor/t3code/"):
            continue
        if destination in assets:
            raise ValueError(f"Adapted source must not be classified as local asset: {destination}")
        data = safe_file(repository, destination).read_bytes()
        if digest(data) != entry["sha256"]:
            raise ValueError(f"Recapture supplemental adaptation first: {destination}")
        recipes.append({
            "destination": destination,
            "adaptation": "vendor/t3code/mcp-skills-adaptations.json",
            "sha256": entry["sha256"], "bytes": entry["bytes"], "mode": entry["mode"],
            "provenance": entry["provenance"],
        })
if arguments.review_actions:
    manifest_bytes = encoded(manifest)
inventory["sourceManifestSha256"] = digest(manifest_bytes)
inventory["modePolicy"] = {
    "creation": "Canonical POSIX 0644 for non-executable files and 0755 for executable files; no special-mode bits.",
    "existingDestination": "Match content hash and Git-style executable class (any POSIX execute bit, mode & 0111). Ordinary read/write permission differences such as 0644 versus 0664 are retained untouched.",
    "unsafeDestination": "Reject setuid, setgid and sticky bits (mode & 07000) on regular files before any destination writes; symlinks and nonregular targets remain refused.",
}
inventory["files"] = sorted(recipes, key=lambda entry: entry["destination"])
inventory["summary"] = {
    "upstreamInputs": len(manifest["files"]),
    "upstreamSelected": len(selected),
    "upstreamPristine": sum(entry["provenance"] == "pristine-upstream" for entry in recipes),
    "upstreamPatched": len(patches),
    "existingAdditionalAssets": len(assets),
    "outputFilesExcludingSelf": len(recipes),
}
host_inputs = inventory.setdefault("runtimeResources", {}).setdefault("hostBuildInputs", [])
host_paths = {entry["path"] for entry in host_inputs}
for relative in arguments.allow_host_input:
    # Enrolling a path is not approving its previous bytes; the exact current
    # regular contained file is read below, before any publication happens.
    if relative not in host_paths:
        host_inputs.append({"path": relative})
        host_paths.add(relative)
for entry in host_inputs:
    entry["sha256"] = digest(safe_file(repository, entry["path"]).read_bytes())
# All immutable/local inputs are read and all recipes constructed before publication.
for relative, data in sorted(patches.items()):
    publish(safe_file(repository, relative), data)
if arguments.review_actions:
    publish(vendor / "source-manifest.json", manifest_bytes)
publish(vendor / "sync-inventory.json", encoded(inventory))
print(json.dumps({"commit": commit, "patches": len(patches), "outputs": len(recipes) + 1, "operation": "reviewed-authoring-only"}))
