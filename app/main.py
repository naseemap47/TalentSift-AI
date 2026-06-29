import asyncio
import io
import json
import os
import zipfile
from typing import List, Optional
import httpx
from fastapi import FastAPI, Depends, HTTPException, status, UploadFile, File, Form, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr
from pypdf import PdfReader
from sqlalchemy.orm import Session

from app.database import engine, Base, get_db, SessionLocal
from app.models import User, Job, Resume
from app.auth import get_password_hash, verify_password, create_access_token, get_current_user
from app.agents.graph import app_graph
from app.jobs_manager import get_tracker

# Create database tables
Base.metadata.create_all(bind=engine)

app = FastAPI(title="TalentSift-AI API", version="0.1.0")

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pydantic Schemas
class UserSignup(BaseModel):
    email: EmailStr
    password: str
    full_name: str

class UserResponse(BaseModel):
    id: int
    email: EmailStr
    full_name: Optional[str]

    class Config:
        from_attributes = True

class Token(BaseModel):
    access_token: str
    token_type: str

class ModelPullRequest(BaseModel):
    model: str

# In-memory Ollama pulling progress status
pull_status = {
    "model": None,
    "status": "idle",
    "completed": 0,
    "total": 0,
    "error": None
}

# --- AUTH ROUTERS ---

@app.post("/api/auth/signup", response_model=UserResponse)
def signup(user_in: UserSignup, db: Session = Depends(get_db)):
    db_user = db.query(User).filter(User.email == user_in.email).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    hashed_pw = get_password_hash(user_in.password)
    user = User(email=user_in.email, hashed_password=hashed_pw, full_name=user_in.full_name)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user

@app.post("/api/auth/login", response_model=Token)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token = create_access_token(data={"sub": user.email})
    return {"access_token": access_token, "token_type": "bearer"}

@app.get("/api/auth/me", response_model=UserResponse)
def read_users_me(current_user: User = Depends(get_current_user)):
    return current_user

# --- OLLAMA ROUTERS ---

@app.get("/api/ollama/models")
async def get_ollama_models():
    """Fetch list of local Ollama models."""
    url = "http://localhost:11434/api/tags"
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=5.0)
            if response.status_code == 200:
                data = response.json()
                models = [item["name"] for item in data.get("models", [])]
                return {"models": models}
            else:
                return {"models": [], "warning": f"Ollama API returned status {response.status_code}"}
    except Exception as e:
        return {"models": [], "warning": f"Could not connect to local Ollama instance: {str(e)}"}

async def pull_model_task(model_name: str):
    global pull_status
    pull_status = {
        "model": model_name,
        "status": "pulling manifest",
        "completed": 0,
        "total": 0,
        "error": None
    }
    
    url = "http://localhost:11434/api/pull"
    payload = {"name": model_name}
    
    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            async with client.stream("POST", url, json=payload) as response:
                if response.status_code != 200:
                    raise Exception(f"Ollama returned HTTP status {response.status_code}")
                
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    try:
                        # Parse Ollama progress stream
                        data = json.loads(line)
                        status_msg = data.get("status", "")
                        completed = data.get("completed", 0)
                        total = data.get("total", 0)
                        
                        pull_status["status"] = status_msg
                        pull_status["completed"] = completed
                        pull_status["total"] = total
                    except Exception:
                        pass
        pull_status["status"] = "success"
    except Exception as e:
        pull_status["status"] = "error"
        pull_status["error"] = str(e)

@app.post("/api/ollama/pull")
def pull_ollama_model(req: ModelPullRequest, background_tasks: BackgroundTasks, current_user: User = Depends(get_current_user)):
    global pull_status
    if pull_status["status"] in ["downloading", "pulling manifest"]:
        raise HTTPException(status_code=400, detail="A model pull is already in progress.")
    
    background_tasks.add_task(pull_model_task, req.model)
    return {"message": f"Started pulling model '{req.model}' in the background."}

@app.get("/api/ollama/pull/status")
def get_pull_status(current_user: User = Depends(get_current_user)):
    return pull_status

# --- RESUME SHORTLISTING JOB ROUTERS ---

def extract_pdf_text(file_bytes: bytes) -> str:
    pdf = PdfReader(io.BytesIO(file_bytes))
    text = ""
    for page in pdf.pages:
        t = page.extract_text()
        if t:
            text += t + "\n"
    return text

def extract_resumes_from_zip(zip_bytes: bytes) -> List[dict]:
    resumes = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        for filename in z.namelist():
            # Skip macOS metadata or folders
            if filename.lower().endswith('.pdf') and not filename.startswith('__MACOSX') and not filename.endswith('/'):
                try:
                    pdf_data = z.read(filename)
                    text = extract_pdf_text(pdf_data)
                    base_name = os.path.basename(filename)
                    if base_name:
                        resumes.append({
                            "filename": base_name,
                            "text": text
                        })
                except Exception as e:
                    print(f"Error reading PDF {filename} inside zip: {e}")
    return resumes

async def run_shortlisting_workflow(job_id: str):
    tracker = get_tracker(job_id)
    
    db = SessionLocal()
    try:
        job = db.query(Job).filter(Job.id == job_id).first()
        if not job:
            tracker.update(stage="failed")
            tracker.add_log("Error: Job not found in database.")
            return
        
        job.status = "running"
        db.commit()
        
        resumes_db = db.query(Resume).filter(Resume.job_id == job_id).all()
        resumes_state = []
        for r in resumes_db:
            resumes_state.append({
                "id": r.id,
                "filename": r.filename,
                "text": r.text,
                "relevant": None,
                "filter_analysis": None,
                "score": None,
                "scorer_analysis": None,
                "rank": None,
                "ranker_analysis": None
            })
            
        inputs = {
            "job_id": job.id,
            "job_description": job.jd_text,
            "resumes": resumes_state,
            "filter_model": job.filter_model,
            "scorer_model": job.scorer_model,
            "ranker_model": job.ranker_model,
            "embedding_model": job.embedding_model
        }
        
        tracker.add_log("Initializing LangGraph process...")
        # Run synchronous LangGraph execution in a separate thread so it doesn't block the event loop
        await asyncio.to_thread(app_graph.invoke, inputs)
        
    except Exception as e:
        tracker.update(stage="failed")
        tracker.add_log(f"Pipeline crashed with error: {str(e)}")
        # Update job status in DB to failed
        try:
            job = db.query(Job).filter(Job.id == job_id).first()
            if job:
                job.status = "failed"
                db.commit()
        except Exception:
            pass
    finally:
        db.close()

@app.post("/api/jobs", status_code=201)
async def create_job(
    background_tasks: BackgroundTasks,
    title: str = Form(...),
    jd_text: Optional[str] = Form(None),
    jd_file: Optional[UploadFile] = File(None),
    resumes_files: List[UploadFile] = File(...),
    filter_model: str = Form(...),
    scorer_model: str = Form(...),
    ranker_model: str = Form(...),
    embedding_model: str = Form(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    # Extract Job Description text
    final_jd_text = ""
    if jd_text and jd_text.strip():
        final_jd_text = jd_text.strip()
    elif jd_file:
        file_bytes = await jd_file.read()
        if jd_file.filename.lower().endswith(".pdf"):
            final_jd_text = extract_pdf_text(file_bytes)
        else:
            final_jd_text = file_bytes.decode("utf-8", errors="ignore")
            
    if not final_jd_text:
        raise HTTPException(status_code=400, detail="Job Description must be provided as text or PDF file.")

    # Process Resumes (Limit check: 100 resumes)
    extracted_resumes = []
    for r_file in resumes_files:
        file_bytes = await r_file.read()
        filename = r_file.filename.lower()
        
        if filename.endswith(".pdf"):
            text = extract_pdf_text(file_bytes)
            extracted_resumes.append({
                "filename": r_file.filename,
                "text": text
            })
        elif filename.endswith(".zip"):
            res_list = extract_resumes_from_zip(file_bytes)
            extracted_resumes.extend(res_list)
        else:
            # Assume text/raw file
            text = file_bytes.decode("utf-8", errors="ignore")
            extracted_resumes.append({
                "filename": r_file.filename,
                "text": text
            })
            
    if not extracted_resumes:
        raise HTTPException(status_code=400, detail="No PDF resumes found in the upload.")

    if len(extracted_resumes) > 100:
        raise HTTPException(status_code=400, detail=f"Maximum limit of 100 resumes exceeded. You uploaded {len(extracted_resumes)} resumes.")

    # Create Job database record
    job = Job(
        user_id=current_user.id,
        title=title,
        jd_text=final_jd_text,
        filter_model=filter_model,
        scorer_model=scorer_model,
        ranker_model=ranker_model,
        embedding_model=embedding_model,
        status="pending"
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    # Create Resume database records
    for res in extracted_resumes:
        db_res = Resume(
            job_id=job.id,
            filename=res["filename"],
            text=res["text"]
        )
        db.add(db_res)
    db.commit()

    # Pre-populate in-memory progress tracker data
    tracker = get_tracker(job.id)
    tracker.data = {
        "stage": "idle",
        "logs": ["Job created. Awaiting worker execution..."],
        "filter": {"current": 0, "total": len(extracted_resumes), "status": "idle"},
        "scorer": {"current": 0, "total": 0, "status": "idle"},
        "ranker": {"current": 0, "total": 0, "status": "idle"},
    }

    # Queue background task
    background_tasks.add_task(run_shortlisting_workflow, job.id)

    return {"job_id": job.id, "resume_count": len(extracted_resumes)}

@app.get("/api/jobs")
def get_jobs(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    jobs = db.query(Job).filter(Job.user_id == current_user.id).order_by(Job.created_at.desc()).all()
    # Simple formatting
    results = []
    for job in jobs:
        total_resumes = db.query(Resume).filter(Resume.job_id == job.id).count()
        results.append({
            "id": job.id,
            "title": job.title,
            "status": job.status,
            "total_resumes": total_resumes,
            "created_at": job.created_at
        })
    return results

@app.get("/api/jobs/{job_id}")
def get_job_details(job_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id, Job.user_id == current_user.id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
        
    resumes = db.query(Resume).filter(Resume.job_id == job_id).all()
    
    resumes_list = []
    for r in resumes:
        resumes_list.append({
            "id": r.id,
            "filename": r.filename,
            "relevant": r.relevant,
            "filter_analysis": r.filter_analysis,
            "score": r.score,
            "scorer_analysis": r.scorer_analysis,
            "rank": r.rank,
            "ranker_analysis": r.ranker_analysis
        })
        
    return {
        "id": job.id,
        "title": job.title,
        "jd_text": job.jd_text,
        "filter_model": job.filter_model,
        "scorer_model": job.scorer_model,
        "ranker_model": job.ranker_model,
        "embedding_model": job.embedding_model,
        "status": job.status,
        "created_at": job.created_at,
        "resumes": resumes_list
    }

@app.get("/api/jobs/{job_id}/stream")
async def stream_job_progress(
    job_id: str,
    request: Request,
    token: Optional[str] = None,
    db: Session = Depends(get_db)
):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    
    # Try token query param first, then Authorization header
    actual_token = token
    if not actual_token:
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            actual_token = auth_header.split(" ")[1]
            
    if not actual_token:
        raise credentials_exception
        
    try:
        from jose import jwt
        from app.auth import SECRET_KEY, ALGORITHM
        payload = jwt.decode(actual_token, SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            raise credentials_exception
    except Exception:
        raise credentials_exception
        
    user = db.query(User).filter(User.email == email).first()
    if user is None:
        raise credentials_exception

    tracker = get_tracker(job_id)
    
    async def event_generator():
        q = tracker.subscribe()
        try:
            while True:
                data = await q.get()
                yield f"data: {json.dumps(data)}\n\n"
                if data["stage"] in ["completed", "failed"]:
                    break
        except asyncio.CancelledError:
            pass
        finally:
            tracker.unsubscribe(q)
            
    return StreamingResponse(event_generator(), media_type="text/event-stream")
