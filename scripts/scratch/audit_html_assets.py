import re
from pathlib import Path

def audit_html_assets():
    html_files = ["login.html", "citizen.html", "barangay.html", "admin.html", "index.html"]
    print("=== AUDITING HTML ASSET REFERENCES ===")
    
    for h in html_files:
        hp = Path(h)
        if not hp.exists():
            print(f"[MISSING HTML] {h}")
            continue
        with open(hp, "r", encoding="utf-8") as f:
            content = f.read()
            
        # find scripts
        scripts = re.findall(r'<script\s+[^>]*src=["\']([^"\']+)["\']', content)
        # find stylesheets
        css = re.findall(r'<link\s+[^>]*href=["\']([^"\']+)["\']', content)
        
        print(f"\n[{h}] Assets:")
        for s in scripts:
            if s.startswith("http"):
                print(f"  External script: {s}")
            else:
                p = Path(s)
                print(f"  Local script: {s} -> {'EXISTS' if p.exists() else 'MISSING'}")
        for c in css:
            if c.startswith("http"):
                print(f"  External css: {c}")
            else:
                p = Path(c)
                print(f"  Local css: {c} -> {'EXISTS' if p.exists() else 'MISSING'}")

if __name__ == "__main__":
    audit_html_assets()
