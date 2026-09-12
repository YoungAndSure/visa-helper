#!/usr/bin/env python3
"""Generate drafts from administrator reference documents; explicitly publish reviewed rules."""
import argparse
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from backend.modules.audit_rules.schemas import RuleSet
from backend.modules.audit_rules.store import RuleStore
from backend.modules.rule_generation.service import generate_from_directory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", type=Path, help="Override rule library directory")
    commands = parser.add_subparsers(dest="command", required=True)
    generate = commands.add_parser("generate", help="Send administrator reference sources to LLM and save a draft")
    generate.add_argument("--country", required=True)
    generate.add_argument("--visa-type", default="schengen-tourism")
    generate.add_argument("--input", type=Path, required=True)
    publish = commands.add_parser("publish", help="Publish a reviewed draft; replaces the active version and retains history")
    publish.add_argument("--draft", type=Path, required=True)
    args = parser.parse_args()
    handlers = [logging.StreamHandler()]
    log_file = os.environ.get("LOG_FILE", str(Path(__file__).resolve().parents[2] / "backend/logs/backend.log"))
    if log_file:
        Path(log_file).parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", handlers=handlers)
    store = RuleStore(root=args.store)
    try:
        if args.command == "generate":
            path = generate_from_directory(args.input, args.country.upper(), args.visa_type, store)
        else:
            ruleset = RuleSet.model_validate_json(args.draft.read_text(encoding="utf-8"))
            path = store.publish(ruleset)
    except Exception as error:
        # Validation/provider exceptions may contain entire source inputs. Do not print them.
        print(f"Operation failed ({type(error).__name__}). Check source format, schema, model configuration and version uniqueness.", file=sys.stderr)
        return 1
    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
