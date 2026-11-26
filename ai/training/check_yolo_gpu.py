import torch

def main():
    print(f"Pytorch: {torch.__version__}")
    print(f"CUDA: {torch.cuda.is_available()}")
    print(f"GPU: {torch.cuda.get_device_name(0)}")

    if torch.cuda.is_available():
        print("GPU IS AVAILABLE")
    else:
        print("GPU IS NOT AVAILABLE")

if __name__ == "__main__":
    main()