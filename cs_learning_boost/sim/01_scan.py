"""Scan: six small tasks. Fill in each function body.

Do what you can. If one stumps you, leave it or write what you'd try.
Say "done" in the chat when you're finished; I'll run everything.
You can run it yourself any time:  python 01_scan.py
"""


# 1 ─────────────────────────────────────────────────────────────
def make_grid(rows, cols):
    """Return a rows x cols grid (a list of lists) filled with 0.

    make_grid(2, 3) -> [[0, 0, 0], [0, 0, 0]]
    Each cell must be changeable on its own:
        g = make_grid(2, 3); g[0][0] = 1  ->  [[1, 0, 0], [0, 0, 0]]
    """
    return [[0,0,0],[0,0,0]]
    


# 2 ─────────────────────────────────────────────────────────────
def word_counts(text):
    """Return a dict mapping each word to how many times it appears.

    Words are separated by whitespace; count them case-insensitively.
    word_counts("the cat The dog") -> {"the": 2, "cat": 1, "dog": 1}
    """
    pass


# 3 ─────────────────────────────────────────────────────────────
def merge_inventory(stock, delivery):
    """Return a NEW dict with the quantities of both added together.

    merge_inventory({"apple": 3, "pear": 1}, {"apple": 2, "fig": 5})
        -> {"apple": 5, "pear": 1, "fig": 5}
    `stock` and `delivery` must be left exactly as they were.
    """
    pass


# 4 ─────────────────────────────────────────────────────────────
def first_duplicate(items):
    """Return the first item that appears for the second time, or None.

    first_duplicate([3, 1, 4, 1, 5, 3]) -> 1   (1 repeats before 3 does)
    first_duplicate([1, 2, 3])          -> None
    Must finish in under a second for a list of 1,000,000 items.
    """
    pass


# 5 ─────────────────────────────────────────────────────────────
def count_unique_pairs(pairs):
    """Count distinct pairs, where [a, b] and [b, a] are the same pair.

    count_unique_pairs([[1, 2], [2, 1], [3, 4], [1, 2]]) -> 2
    Must finish in under a second for 200,000 pairs.
    """
    pass


# 6 ─────────────────────────────────────────────────────────────
def is_balanced(s):
    """Return True if every bracket in s is closed in the right order.

    Brackets are () [] {}. Any other character is ignored.
    is_balanced("a(b[c]{d})") -> True
    is_balanced("(]")         -> False
    is_balanced("(()")        -> False
    """
    pass


if __name__ == "__main__":
    print(make_grid(2, 3))
    print(word_counts("the cat The dog"))
    print(merge_inventory({"apple": 3, "pear": 1}, {"apple": 2, "fig": 5}))
    print(first_duplicate([3, 1, 4, 1, 5, 3]))
    print(count_unique_pairs([[1, 2], [2, 1], [3, 4], [1, 2]]))
    print(is_balanced("a(b[c]{d})"), is_balanced("(]"), is_balanced("(()"))
