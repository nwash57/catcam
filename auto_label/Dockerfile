FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04
RUN apt-get update && apt-get install -y python3 python3-pip libgl1 libglib2.0-0 git && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt
COPY . ./auto_label/
CMD ["uvicorn", "auto_label.main:app", "--host", "0.0.0.0", "--port", "8090"]
