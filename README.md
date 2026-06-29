# 🔍 TalentSift-AI

> **Multi-Agent AI-Powered Resume Shortlisting System** — Built with LangGraph, Ollama, FastAPI, and React.

TalentSift-AI automates the resume shortlisting pipeline through a 3-stage agent architecture: **Filter → Scorer → Ranker**. Each stage uses a dedicated Ollama LLM and streams real-time progress to a premium glassmorphic dashboard.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                       React (Vite + TS)                          │
│  Auth → Dashboard (Upload JD + Resumes) → JobView (SSE Stream)  │
└────────────────────────┬─────────────────────────────────────────┘
                         │ REST + SSE
┌────────────────────────▼─────────────────────────────────────────┐
│                  FastAPI Backend                                  │
│  Auth (JWT) │ Ollama Manager │ Job Processor │ SSE Events        │
└────────────────────────┬─────────────────────────────────────────┘
                         │ LangGraph StateGraph
┌────────────────────────▼─────────────────────────────────────────┐
│              3-Stage LangGraph Pipeline                          │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐          │
│  │Filter Agent │ → │Scorer Agent │ → │Ranker Agent │          │
│  │ (Relevance) │    │  (0-100)    │    │  (Ranking)  │          │
│  └─────────────┘    └─────────────┘    └─────────────┘          │
└──────────────────────────────────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────────┐
│              Local Ollama Instance (Port 11434)                  │
│   nomic-embed-text │ gemma2:2b │ qwen3.5:9b │ qwen3.5:0.8b     │
└──────────────────────────────────────────────────────────────────┘
```

---

## Features

| Feature | Description |
|---|---|
| 🔐 **HR Auth** | Secure signup/login with JWT-based sessions |
| 📄 **JD Upload** | Upload Job Description as text or PDF |
| 📁 **Resume Upload** | Upload up to 100 resumes as PDFs or a ZIP archive |
| 🤖 **Model Selector** | Pick individual Ollama models for each agent stage |
| ⬇️ **Model Puller** | Pull new models from Ollama directly from the UI (with download progress bar) |
| 🔍 **Filter Agent** | LLM filters resumes for relevance to the JD |
| 📊 **Scorer Agent** | LLM scores each relevant resume 0–100 with detailed analysis |
| 🏆 **Ranker Agent** | LLM compares and ranks shortlisted candidates |
| 📡 **Live Progress** | Real-time SSE streaming of logs and per-stage progress bars |
| 🔬 **Agent Analysis** | Modal views for reading each agent's reasoning per resume |
| 📥 **CSV Export** | One-click download of final ranked results as CSV |

---

## Prerequisites

- **Python 3.13+** with `uv` ([install uv](https://github.com/astral-sh/uv))
- **Node.js 18+** (via [NVM](https://github.com/nvm-sh/nvm) recommended)
- **Ollama** running locally on port `11434` ([install Ollama](https://ollama.com))
- At least one LLM model pulled, e.g.: `ollama pull gemma2:2b`

---

## Setup & Running

All components (ports, host addresses, database URLs, security keys, and frontend base URLs) are centrally configured in `config.yaml` at the root of the project.

### 1. Backend (FastAPI)

```bash
# Clone and enter project
cd TalentSift-AI

# Install Python dependencies with uv
uv sync

# Start the FastAPI development server using the configured python -m entrypoint
uv run python -m app.main
```

The API will be live at: **http://localhost:8000** (or as configured in `config.yaml`)  
API docs (Swagger): **http://localhost:8000/docs**

### 2. Frontend (React + Vite)

```bash
cd frontend

# Install Node dependencies
npm install

# Start the Vite dev server
npm run dev
```

Vite reads `config.yaml` dynamically on startup, configuring its server port and pointing to the backend.  
The UI will be live at: **http://localhost:5173** (or as configured in `config.yaml`)

---

## Project Structure

```
TalentSift-AI/
├── app/
│   ├── __init__.py
│   ├── main.py            # FastAPI entry point – all routes & SSE
│   ├── config.py          # Centralized configuration YAML parser
│   ├── database.py        # SQLAlchemy engine + session (from config)
│   ├── models.py          # SQLAlchemy ORM models (User, Job, Resume)
│   ├── auth.py            # JWT + bcrypt helpers (from config)
│   ├── jobs_manager.py    # In-memory SSE progress tracker
│   └── agents/
│       ├── __init__.py
│       └── graph.py       # LangGraph 3-node pipeline (Ollama url from config)
├── frontend/
│   ├── index.html
│   ├── vite.config.ts     # Dynamically parses config.yaml on start
│   └── src/
│       ├── App.tsx         # Root router & auth state
│       ├── index.css       # Premium dark theme CSS
│       └── components/
│           ├── Auth.tsx     # Login + Signup form
│           ├── Dashboard.tsx # Job creation + model config + history
│           └── JobView.tsx   # SSE live feed + tabbed result view
├── config.yaml            # Centralized project configuration
├── pyproject.toml          # uv/Python deps and run script mappings
└── talentsift.db           # SQLite database (auto-created on first run)
```

---

## LangGraph Pipeline Details

### Stage 1 — Filter Agent
- **Model**: Configurable (recommend a fast model like `gemma2:2b`)
- **Task**: For each resume, decides if it's relevant to the JD (true/false) with reasoning
- **Output**: `relevant` (bool) + `filter_analysis` (string) stored per resume

### Stage 2 — Scorer Agent
- **Model**: Configurable (recommend a capable model like `qwen3.5:9b`)
- **Task**: Scores each _relevant_ resume from 0–100 against the JD
- **Output**: `score` (int 0–100) + `scorer_analysis` (string) stored per resume

### Stage 3 — Ranker Agent
- **Model**: Configurable (recommend same capable model)
- **Task**: Compares all scored candidates holistically and assigns final rankings
- **Output**: `rank` (int) + `ranker_analysis` (string) stored per resume

---

## API Reference

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/signup` | Register HR account |
| `POST` | `/api/auth/login` | Login, returns JWT |
| `GET` | `/api/auth/me` | Get current user |
| `GET` | `/api/ollama/models` | List local Ollama models |
| `POST` | `/api/ollama/pull` | Pull a new model in background |
| `GET` | `/api/ollama/pull/status` | Check model pull progress |
| `POST` | `/api/jobs` | Create job + upload JD/resumes |
| `GET` | `/api/jobs` | List all jobs for current user |
| `GET` | `/api/jobs/{job_id}` | Get full job + resume results |
| `GET` | `/api/jobs/{job_id}/stream` | SSE stream for live progress |

---

## Tech Stack

| Layer | Technology |
|---|---|
| **AI Orchestration** | LangGraph 1.2+ |
| **LLM Provider** | Ollama (local, any model) |
| **LLM Client** | langchain-ollama |
| **Backend** | FastAPI + Uvicorn |
| **Auth** | JWT via python-jose + bcrypt |
| **Database** | SQLite + SQLAlchemy 2.0 |
| **PDF Parsing** | pypdf |
| **Frontend** | React 19 + Vite 8 + TypeScript |
| **Styling** | Vanilla CSS (glassmorphism dark theme) |
| **Dependency Mgmt** | uv |
