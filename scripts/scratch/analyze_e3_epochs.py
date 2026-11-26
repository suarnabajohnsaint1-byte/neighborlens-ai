import csv
from pathlib import Path

RESULTS_CSV = Path("models/checkpoints/neighborlens_v8_phase3_e3_road_remediation/results.csv")

with open(RESULTS_CSV, "r", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    rows = list(reader)

cleaned = []
for r in rows:
    c = {k.strip(): float(v.strip()) if v.strip() else 0.0 for k, v in r.items()}
    c["epoch"] = int(c["epoch"])
    map50 = c["metrics/mAP50(B)"]
    map50_95 = c["metrics/mAP50-95(B)"]
    # Standard Ultralytics fitness formula
    c["fitness"] = 0.1 * map50 + 0.9 * map50_95
    cleaned.append(c)

print(f"Total epochs in results.csv: {len(cleaned)}")

# Top 5 epochs by fitness
top_fitness = sorted(cleaned, key=lambda x: x["fitness"], reverse=True)[:5]
print("\nTop 5 epochs by Ultralytics Fitness (0.1*mAP50 + 0.9*mAP50-95):")
for r in top_fitness:
    print(f"  Epoch {r['epoch']:2d}: fitness={r['fitness']:.5f} | mAP50={r['metrics/mAP50(B)']:.5f} | mAP50-95={r['metrics/mAP50-95(B)']:.5f} | P={r['metrics/precision(B)']:.4f} | R={r['metrics/recall(B)']:.4f}")

# Top 5 by mAP50
top_map50 = sorted(cleaned, key=lambda x: x["metrics/mAP50(B)"], reverse=True)[:5]
print("\nTop 5 epochs by validation mAP50:")
for r in top_map50:
    print(f"  Epoch {r['epoch']:2d}: mAP50={r['metrics/mAP50(B)']:.5f} | mAP50-95={r['metrics/mAP50-95(B)']:.5f} | fitness={r['fitness']:.5f}")

# Final epoch
final_r = cleaned[-1]
print(f"\nFinal Epoch {final_r['epoch']}:")
print(f"  mAP50={final_r['metrics/mAP50(B)']:.5f} | mAP50-95={final_r['metrics/mAP50-95(B)']:.5f} | fitness={final_r['fitness']:.5f} | P={final_r['metrics/precision(B)']:.4f} | R={final_r['metrics/recall(B)']:.4f}")
