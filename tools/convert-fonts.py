# 一次性脚本：把用户提供的字体转成 woff2，并读出字体内真实的族名
# 为什么要转：演示夏行楷 10MB、鸿雷拙书 6.5MB，OTF/TTF 直传会让首屏极重。
# woff2 通常能压到原文件的 1/10 左右（brotli），且浏览器全都支持。
import os, sys
from fontTools.ttLib import TTFont

SRC = r"D:\tttt\字体"
DST = r"D:\tttt\Workbuddy\2026-10-05-19-05-22\paper-cloud\assets\fonts"

# 文件名 → 期望的 @font-face 家族名（ASCII，避免 CSS 转义麻烦）
FILES = {
    "Caramel-Regular.ttf":   "Caramel",
    "hongleiHL2.otf":        "HongLeiZhuoShu",
    "jandle.otf":            "Jandle",
    "Rancho-Regular.ttf":    "Rancho",
    "鸿雷拙书简体.otf":       "HongLeiZhuoShu2",
    "演示夏行楷.ttf":          "XiaXingKai",
}

def read_names(font):
    """取出中英文族名 / 全名，用于给用户看真实字体名"""
    out = {}
    try:
        n = font["name"]
        for nid, key in ((1, "family_en"), (4, "full_en"), (16, "typo_family"), (2, "subfamily")):
            r = n.getDebugName(nid)
            if r:
                out[key] = r
    except Exception as e:
        out["err"] = str(e)
    return out

os.makedirs(DST, exist_ok=True)
for fn, family in FILES.items():
    src = os.path.join(SRC, fn)
    if not os.path.exists(src):
        print("缺失:", fn); continue
    try:
        font = TTFont(src, fontNumber=0, lazy=True)
        names = read_names(font)
        # 覆盖 name 表：写入我们指定的家族名，CSS 里就能用干净的名字引用
        for nid, val in ((1, family), (3, "paper-cloud-custom"), (4, family)):
            font["name"].setName(val, nid, 3, 1, 0x409)
            font["name"].setName(val, nid, 1, 0, 0)
        out = os.path.join(DST, family + ".woff2")
        font.flavor = "woff2"
        font.save(out)
        font.close()
        orig = os.path.getsize(src)
        new = os.path.getsize(out)
        print(f"OK  {fn} -> {family}.woff2  {orig/1048576:.1f}MB -> {new/1024:.0f}KB")
        print(f"    内部名: {names}")
    except Exception as e:
        print(f"FAIL {fn}: {e}")
