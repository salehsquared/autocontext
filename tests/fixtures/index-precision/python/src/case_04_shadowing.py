from math_mod import add


def outer() -> int:
    return add(1, 2)


def shadowed() -> int:
    add = lambda x: x + 100
    return add(5)
