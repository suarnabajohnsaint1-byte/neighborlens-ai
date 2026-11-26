from pathlib import Path

v3_train_lbl = Path("data/datasets/neighborlens_v3/labels/train")
empty_files = []
for f in v3_train_lbl.glob("*.txt"):
    with open(f, "r") as fp:
        lines = [l.strip() for l in fp if l.strip()]
        if len(lines) == 0:
            empty_files.append(f.name)

print("Empty label files in v3 train:", empty_files)

# Check their v2 original annotations
v2_train_lbl = Path("data/datasets/neighborlens_v2/labels/train")
for ef in empty_files:
    v2_f = v2_train_lbl / ef
    with open(v2_f, "r") as fp:
        lines = [l.strip() for l in fp if l.strip()]
        print(f"\nv2 original lines for {ef}:")
        for l in lines:
            print("  ", l)
