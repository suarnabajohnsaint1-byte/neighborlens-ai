"""Assess held-out ID fraud scores without reading or transferring ID images."""

import argparse
import csv
import json
import math
from pathlib import Path
from statistics import NormalDist


GROUPS = ("genuine", "monitor_recapture", "ai_edited")
PAD_BONA_FIDE = {"genuine", "genuine_worn"}
PAD_ATTACKS = {"monitor_recapture", "phone_recapture", "printed_grayscale_copy", "printed_color_copy",
               "ai_edited", "synthetic_document", "known_replay"}


def evaluate_pad(scores, threshold):
    """Measure the test split at a threshold fixed before looking at it."""
    seen = set()
    splits = {"document_id": {}, "session_id": {}}
    counts = {group: {"samples": 0, "flagged": 0} for group in PAD_BONA_FIDE | PAD_ATTACKS}
    for index, row in enumerate(scores, start=2):
        try:
            sample, split, group = (row[key].strip() for key in ("sample_id", "split", "category"))
            score = float(row["fraud_score"])
            if not sample or sample in seen or split not in {"train", "validation", "test"} or group not in counts or not 0 <= score <= 1:
                raise ValueError("invalid or duplicated sample")
            for key, owners in splits.items():
                identifier = row[key].strip()
                if not identifier or owners.setdefault(identifier, split) != split:
                    raise ValueError(f"missing or overlapping {key}")
        except (AttributeError, KeyError, TypeError, ValueError) as error:
            raise ValueError(f"Invalid PAD manifest at row {index}: {error}.") from None
        seen.add(sample)
        if split == "test":
            counts[group]["samples"] += 1
            counts[group]["flagged"] += int(score >= threshold)

    negatives = sum(counts[group]["samples"] for group in PAD_BONA_FIDE)
    fp = sum(counts[group]["flagged"] for group in PAD_BONA_FIDE)
    if not negatives or not any(counts[group]["samples"] for group in PAD_ATTACKS):
        raise ValueError("The test split needs both bona fide and attack samples.")
    worn = counts["genuine_worn"]
    attacks = {}
    for group in sorted(PAD_ATTACKS):
        total, tp = counts[group]["samples"], counts[group]["flagged"]
        if not total:
            attacks[group] = None
            continue
        attacks[group] = {"tp": tp, "fn": total - tp, "fp": fp, "tn": negatives - fp,
                          "precision": tp / (tp + fp) if tp + fp else None,
                          "recall": tp / total, "f1": 2 * tp / (total + tp + fp),
                          "apcer": (total - tp) / total}
    return {"threshold": threshold, "counts": counts, "bpcer": fp / negatives,
            "worn_false_rejection_rate": worn["flagged"] / worn["samples"] if worn["samples"] else None,
            "attack_metrics": attacks}


def upper_error_bound(errors, total):
    """One-sided 95% Wilson upper confidence bound."""
    z = NormalDist().inv_cdf(0.95)
    rate = errors / total
    scale = z * z / total
    return (rate + scale / 2 + z * math.sqrt((rate * (1 - rate) + scale / 4) / total)) / (1 + scale)


def evaluate(scores, threshold, max_false_alarm, max_missed_attack):
    counts = {group: {"samples": 0, "errors": 0} for group in GROUPS}
    seen = set()
    for index, row in enumerate(scores, start=2):
        try:
            group, sample = row["category"], row["sample_id"].strip()
            score = float(row["fraud_score"])
            if group not in counts or not sample or sample in seen or not 0 <= score <= 1:
                raise ValueError()
        except (AttributeError, KeyError, TypeError, ValueError):
            raise ValueError(f"Invalid or duplicate sample at row {index}.") from None
        seen.add(sample)
        flagged = score >= threshold
        counts[group]["samples"] += 1
        counts[group]["errors"] += int(flagged if group == "genuine" else not flagged)

    for group, report in counts.items():
        total = report["samples"]
        if not total:
            raise ValueError(f"Missing held-out samples for {group}.")
        limit = max_false_alarm if group == "genuine" else max_missed_attack
        upper = upper_error_bound(report["errors"], total)
        report.update(error_rate=report["errors"] / total, upper_95=upper, meets_limit=upper <= limit)
    genuine = counts["genuine"]
    false_positives = genuine["errors"]
    true_negatives = genuine["samples"] - false_positives
    categories = {}
    for group in GROUPS[1:]:
        attack = counts[group]
        true_positives = attack["samples"] - attack["errors"]
        positives = true_positives + false_positives
        f1_denominator = 2 * true_positives + false_positives + attack["errors"]
        categories[group] = {
            "accuracy": (true_positives + true_negatives) / (attack["samples"] + genuine["samples"]),
            "precision": true_positives / positives if positives else None,
            "recall": true_positives / attack["samples"],
            "f1": 2 * true_positives / f1_denominator,
            "false_positive_rate": genuine["error_rate"],
            "false_negative_rate": attack["error_rate"],
        }
    return {
        "threshold": threshold, "groups": counts, "attack_metrics": categories,
        "passed": all(report["meets_limit"] for report in counts.values()),
    }


def probability(value):
    number = float(value)
    if not 0 < number < 1:
        raise argparse.ArgumentTypeError("Expected a number strictly between 0 and 1.")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scores", type=Path)
    parser.add_argument("--threshold", type=probability, required=True)
    parser.add_argument("--pad", action="store_true", help="Evaluate a document- and session-disjoint PAD score manifest")
    parser.add_argument("--max-false-alarm", type=probability)
    parser.add_argument("--max-missed-attack", type=probability)
    args = parser.parse_args()
    if not args.pad and (args.max_false_alarm is None or args.max_missed_attack is None):
        parser.error("Supply --max-false-alarm and --max-missed-attack for the readiness check.")
    try:
        with args.scores.open(newline="", encoding="utf-8-sig") as source:
            scores = csv.DictReader(source)
            report = evaluate_pad(scores, args.threshold) if args.pad else evaluate(
                scores, args.threshold, args.max_false_alarm, args.max_missed_attack)
    except OSError:
        parser.exit(2, "Could not read the scores file.\n")
    except ValueError as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(report))
    return 0 if args.pad or report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
