import os
from pathlib import Path

def assess_background():
    v1_dir = Path(__file__).resolve().parents[2] / "data" / "datasets" / "neighborlens_v1"
    incoming_dir = Path(__file__).resolve().parents[2] / "data" / "datasets" / "incoming_images"
    infra_dir = Path(__file__).resolve().parents[2] / "data" / "datasets" / "infrastructure_v3"
    
    print("=== Background & Negative Sample Coverage Audit ===")
    
    # Check v1
    for s in ["train", "val", "test"]:
        lbl_files = list((v1_dir / "labels" / s).glob("*.txt"))
        empty_lbls = [f for f in lbl_files if os.path.getsize(f) == 0]
        print(f"neighborlens_v1 [{s}]: {len(lbl_files)} labels, {len(empty_lbls)} empty background labels")
        
    print("\nIncoming directories:")
    if incoming_dir.exists():
        for d in incoming_dir.iterdir():
            if d.is_dir():
                print(f"  {d.name}: {len(list(d.glob('*')))} files")
                
    print("\nInfrastructure v3 directories:")
    if infra_dir.exists():
        for d in infra_dir.iterdir():
            if d.is_dir():
                print(f"  {d.name}: {len(list(d.glob('*')))} files")

if __name__ == "__main__":
    assess_background()
