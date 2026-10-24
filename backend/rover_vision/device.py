import torch


def default_device() -> str:
    """Best available torch device: Apple GPU, then CUDA, then CPU."""
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "0"
    return "cpu"
