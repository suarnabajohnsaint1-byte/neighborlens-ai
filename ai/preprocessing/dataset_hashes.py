"""Image hashes shared by the dataset audit and the v2 restratifier."""

import hashlib

import cv2
import numpy as np


def compute_sha256(filepath):
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def compute_64phash(img_path, hash_size=8):
    img = cv2.imread(str(img_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None
    resized = cv2.resize(img, (32, 32), interpolation=cv2.INTER_AREA)
    dct = cv2.dct(np.float32(resized))
    dct_low = dct[:hash_size, :hash_size]
    med = np.median(dct_low)
    return "".join(["1" if px > med else "0" for px in dct_low.flatten()])


def hamming_dist(s1, s2):
    return sum(c1 != c2 for c1, c2 in zip(s1, s2))
