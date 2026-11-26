"""Offline, per-defect severity candidate. No model from this CLI is published to the app."""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy.optimize import minimize
from scipy.special import expit

from ai.training.severity_dataset import CATEGORIES, LABELS, digest, reviewed_cases, rows
from ai.training.severity_pairs import FEATURE_VERSION, detector_identity, observations


def fit(records, positive_label="MAJOR"):
    x = np.array([r["features"] for r in records], dtype=float)
    y = np.array([r["label"] == positive_label for r in records], dtype=float)
    if len(set(y)) != 2:
        raise ValueError("Training requires usable, reviewed Minor and Major cases")
    mean, scale = x.mean(axis=0), x.std(axis=0)
    scale[scale == 0] = 1
    x = np.column_stack([np.ones(len(x)), (x - mean) / scale])

    def loss(beta):
        z = x @ beta
        penalty = np.r_[0., beta[1:]]
        return (np.logaddexp(0, z) - y * z).sum() + penalty @ penalty / 2, x.T @ (expit(z) - y) + penalty

    solution = minimize(loss, np.zeros(x.shape[1]), jac=True, method="L-BFGS-B")
    if not solution.success:
        raise ValueError(solution.message)
    return {"mean": mean.tolist(), "scale": scale.tolist(), "weights": solution.x.tolist()}


def predict(model, vector, cutoffs):
    if vector is None:
        return "INSUFFICIENT"
    standardized = (np.asarray(vector) - model["mean"]) / model["scale"]
    weights = model["weights"]
    score = expit(weights[0] + standardized @ weights[1:])
    low, high = cutoffs
    return "MINOR" if score <= low else "MAJOR" if score >= high else "INSUFFICIENT"


def evaluate(model, records, category, cutoffs):
    matrix = {label: dict.fromkeys(LABELS, 0) for label in LABELS}
    sites = set()
    inspected_major = false_minor = 0
    wrong_class_alerts = 0
    for case in records:
        same_route = case["detected_category"] == category
        prediction = predict(model, case["features"] if same_route else None, cutoffs)
        if case["category"] == category:
            matrix[case["label"]][prediction] += 1
            sites.add(case["site_id"])
            if case["inspection_class"] == "MAJOR":
                inspected_major += 1
                false_minor += prediction == "MINOR"
        elif same_route and prediction != "INSUFFICIENT":
            wrong_class_alerts += 1
    if any(not sum(row.values()) for row in matrix.values()):
        raise ValueError(f"{category} evaluation needs reviewed Minor, Major and insufficient cases")
    major = matrix["MAJOR"]
    tp = major["MAJOR"]
    predicted_major = sum(row["MAJOR"] for row in matrix.values())
    total = sum(sum(row.values()) for row in matrix.values())
    by_class = {}
    for label in LABELS:
        correct = matrix[label][label]
        observed = sum(matrix[label].values())
        called = sum(row[label] for row in matrix.values())
        by_class[label] = {"precision": correct / called if called else None, "recall": correct / observed,
                           "f1": 2 * correct / (called + observed), "support": observed}
    return {"matrix_truth_by_prediction": matrix, "sites": len(sites),
            "by_class": by_class,
            "major_precision": tp / predicted_major if predicted_major else None,
            "major_recall": tp / sum(major.values()), "major_f1": 2 * tp / (predicted_major + sum(major.values())),
            "false_minor_rate_among_inspected_major": false_minor / inspected_major,
            "coverage": 1 - sum(row["INSUFFICIENT"] for row in matrix.values()) / total,
            "wrong_category_binary_alerts": wrong_class_alerts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("train", "evaluate"))
    for name in ("dataset", "inventory", "reviews", "policy", "model"):
        parser.add_argument(name, type=Path)
    parser.add_argument("category", choices=sorted(CATEGORIES))
    args = parser.parse_args()
    catalog, policy = rows(args.inventory), json.loads(args.policy.read_text(encoding="utf-8-sig"))
    cases = list(reviewed_cases(catalog, rows(args.reviews), policy))
    checkpoint, runtime = detector_identity()
    identity = {"category": args.category, "features": FEATURE_VERSION, "policy": digest(args.policy),
                "inventory": digest(args.inventory), "reviews": digest(args.reviews), "checkpoint": checkpoint["sha256"],
                "image_size": runtime["image_size"], "confidence": runtime["confidence"]}
    cutoffs = policy["research_score_cutoffs"][args.category]
    if len(cutoffs) != 2 or not 0 < cutoffs[0] < cutoffs[1] < 1:
        parser.error("Pre-register two ordered score cutoffs strictly between zero and one")
    if args.command == "train":
        development = [r for r in cases if r["split"] != "test"]
        measured = list(observations(args.dataset, catalog, development))
        eligible = [r for r in measured if r["split"] == "train" and r["label"] in LABELS[:2]
                    and r["category"] == r["detected_category"] == args.category and r["features"] is not None]
        model = fit(eligible)
        metrics = evaluate(model, [r for r in measured if r["split"] == "development"], args.category, cutoffs)
        with args.model.open("x", encoding="utf-8") as stream:
            json.dump({"identity": identity, "candidate": model, "development": metrics}, stream, allow_nan=False)
    else:
        frozen = json.loads(args.model.read_text(encoding="utf-8"))
        if frozen["identity"] != identity:
            parser.error("Model, data, detector and rubric must match the frozen experiment")
        test = [r for r in cases if r["split"] == "test"]
        metrics = evaluate(frozen["candidate"], observations(args.dataset, catalog, test), args.category, cutoffs)
    print(json.dumps(metrics, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
