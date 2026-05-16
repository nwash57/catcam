# syntax=docker/dockerfile:1
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04
RUN apt-get update && apt-get install -y python3 python3-pip libgl1 libglib2.0-0 git && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip3 install -r requirements.txt
COPY *.py ./
CMD ["sh", "-c", "python3 prepare_dataset.py && python3 run_training.py"]
