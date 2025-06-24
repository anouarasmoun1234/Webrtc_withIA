# WebRTC\_withIA

This repository contains a WebRTC peer-to-peer mesh video conference with an embedded AI chat agent.

## Prerequisites

* **Node.js** (v18+)
* **npm**
* **Python 3.10+**
* **pip**

## 1. Clone the repository

```
git clone https://github.com/anouarasmoun1234/Webrtc_withIA.git
cd Webrtc_withIA
```

## 2. Signalling Server (Node.js)

```
cd signalling
npm install ws uuid
node server.js
```

---

## 3. Web Client (P2P mesh + chat)

```
cd client
npm install http-server --global
http-server . -p 8080
```

Open your browser at **[http://localhost:8080/peerconnection.html#](http://localhost:8080/peerconnection.html#)<roomId>** (e.g. `#room123`).

---

## 4. AI Inference API (Python FastAPI)

```bash
cd ai_server
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn transformers peft datasets torch
uvicorn server:app --reload --port 8000
```

The AI API will listen on **[http://localhost:8000/generate](http://localhost:8000/generate)**

---

## 5. Headless AI Agent (Puppeteer)

```bash
cd ai
npm install puppeteer ws
node agent.js <roomId> <agentName>
```
