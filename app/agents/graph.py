import json
import re
from typing import List, Dict, Any, TypedDict
from langchain_ollama import ChatOllama
from langgraph.graph import StateGraph, END

from app.config import config
from app.database import SessionLocal
from app.models import Job, Resume
from app.jobs_manager import get_tracker

# State Definitions
class ResumeState(TypedDict):
    id: str
    filename: str
    text: str
    relevant: bool | None
    filter_analysis: str | None
    score: int | None
    scorer_analysis: str | None
    rank: int | None
    ranker_analysis: str | None

class AgentState(TypedDict):
    job_id: str
    job_description: str
    resumes: List[ResumeState]
    filter_model: str
    scorer_model: str
    ranker_model: str
    embedding_model: str

def clean_and_parse_json(text: str) -> dict:
    """Helper to extract JSON safely from LLM output."""
    text = text.strip()
    # Check for markdown code blocks
    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if match:
        text = match.group(1)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Fallback: search for first { and last }
        start = text.find('{')
        end = text.rfind('}')
        if start != -1 and end != -1:
            try:
                return json.loads(text[start:end+1])
            except Exception:
                pass
        raise ValueError(f"Could not parse valid JSON from LLM output: {text}")

# Node 1: Filter Agent
def filter_node(state: AgentState) -> Dict[str, Any]:
    job_id = state["job_id"]
    tracker = get_tracker(job_id)
    
    tracker.update(stage="filtering", filter={"current": 0, "total": len(state["resumes"]), "status": "running"})
    tracker.add_log(f"Starting Filter Agent with model: {state['filter_model']}...")

    # Initialize model
    try:
        llm = ChatOllama(
            model=state["filter_model"],
            temperature=0.0,
            format="json",
            base_url=config.ollama.base_url,
        )
    except Exception as e:
        error_msg = f"Failed to initialize Ollama filter model '{state['filter_model']}': {str(e)}"
        tracker.add_log(error_msg)
        tracker.update(stage="failed", filter={"status": "failed"})
        raise RuntimeError(error_msg)

    db = SessionLocal()
    updated_resumes = []
    
    for i, res in enumerate(state["resumes"]):
        tracker.add_log(f"Filtering resume {i+1}/{len(state['resumes'])}: {res['filename']}")
        
        prompt = f"""You are an expert HR recruitment assistant. Your task is to evaluate if a candidate's resume is relevant to the Job Description.

Job Description:
{state['job_description']}

Resume Content (Candidate: {res['filename']}):
{res['text']}

You must decide if this candidate has any relevant background, skills, or potential for the job (even junior or transferable skills).
Output a JSON object with exactly two keys:
1. "relevant": a boolean (true or false). Set to true if relevant, false if completely unrelated.
2. "reasoning": a brief 1-2 sentence explanation of your decision.

Valid JSON Output:"""

        try:
            response = llm.invoke(prompt)
            result = clean_and_parse_json(response.content)
            
            relevant = result.get("relevant", False)
            reasoning = result.get("reasoning", "No explanation provided.")
            
            tracker.add_log(f"Filter Result for {res['filename']}: Relevant={relevant}. Reasoning: {reasoning}")
        except Exception as e:
            tracker.add_log(f"Error filtering resume {res['filename']}: {str(e)}. Defaulting to False.")
            relevant = False
            reasoning = f"Error during filtering: {str(e)}"

        # Save to DB
        db_resume = db.query(Resume).filter(Resume.id == res["id"]).first()
        if db_resume:
            db_resume.relevant = relevant
            db_resume.filter_analysis = reasoning
            db.commit()

        res["relevant"] = relevant
        res["filter_analysis"] = reasoning
        updated_resumes.append(res)
        
        tracker.update(filter={"current": i+1})

    db.close()
    tracker.update(filter={"status": "completed"})
    tracker.add_log("Filter Agent completed successfully.")
    
    return {"resumes": updated_resumes}

# Node 2: Scorer Agent
def scorer_node(state: AgentState) -> Dict[str, Any]:
    job_id = state["job_id"]
    tracker = get_tracker(job_id)
    
    # Identify relevant resumes
    relevant_resumes = [r for r in state["resumes"] if r.get("relevant") is True]
    
    tracker.update(stage="scoring", scorer={"current": 0, "total": len(relevant_resumes), "status": "running"})
    tracker.add_log(f"Starting Scorer Agent on {len(relevant_resumes)} relevant resumes with model: {state['scorer_model']}...")

    if not relevant_resumes:
        tracker.add_log("No relevant resumes found. Skipping Scorer stage.")
        tracker.update(scorer={"status": "completed"})
        return {"resumes": state["resumes"]}

    # Initialize model
    try:
        llm = ChatOllama(
            model=state["scorer_model"],
            temperature=0.1,
            format="json",
            base_url=config.ollama.base_url,
        )
    except Exception as e:
        error_msg = f"Failed to initialize Ollama scorer model '{state['scorer_model']}': {str(e)}"
        tracker.add_log(error_msg)
        tracker.update(stage="failed", scorer={"status": "failed"})
        raise RuntimeError(error_msg)

    db = SessionLocal()
    updated_resumes = {r["id"]: r for r in state["resumes"]}
    
    for i, res in enumerate(relevant_resumes):
        tracker.add_log(f"Scoring resume {i+1}/{len(relevant_resumes)}: {res['filename']}")
        
        prompt = f"""You are an HR Evaluation expert. Your task is to score a candidate's resume against the Job Description.

Job Description:
{state['job_description']}

Resume Content (Candidate: {res['filename']}):
{res['text']}

Rate the candidate on a scale of 0 to 100 based on their experience, matching skills, qualifications, and fit.
Provide a JSON object with exactly two keys:
1. "score": an integer between 0 and 100.
2. "reasoning": a detailed evaluation including key matching skills, missing skills, and suitability.

Valid JSON Output:"""

        try:
            response = llm.invoke(prompt)
            result = clean_and_parse_json(response.content)
            
            score = int(result.get("score", 50))
            reasoning = result.get("reasoning", "No explanation provided.")
            
            tracker.add_log(f"Scorer Result for {res['filename']}: Score={score}/100. Reasoning: {reasoning}")
        except Exception as e:
            tracker.add_log(f"Error scoring resume {res['filename']}: {str(e)}. Defaulting to 50.")
            score = 50
            reasoning = f"Error during scoring: {str(e)}"

        # Save to DB
        db_resume = db.query(Resume).filter(Resume.id == res["id"]).first()
        if db_resume:
            db_resume.score = score
            db_resume.scorer_analysis = reasoning
            db.commit()

        # Update local states
        res_id = res["id"]
        updated_resumes[res_id]["score"] = score
        updated_resumes[res_id]["scorer_analysis"] = reasoning
        
        tracker.update(scorer={"current": i+1})

    db.close()
    tracker.update(scorer={"status": "completed"})
    tracker.add_log("Scorer Agent completed successfully.")
    
    return {"resumes": list(updated_resumes.values())}

# Node 3: Ranker Agent
def ranker_node(state: AgentState) -> Dict[str, Any]:
    job_id = state["job_id"]
    tracker = get_tracker(job_id)
    
    # Filter scored resumes
    scored_resumes = [r for r in state["resumes"] if r.get("score") is not None]
    
    tracker.update(stage="ranking", ranker={"current": 0, "total": len(scored_resumes), "status": "running"})
    tracker.add_log(f"Starting Ranker Agent on {len(scored_resumes)} candidates with model: {state['ranker_model']}...")

    if not scored_resumes:
        tracker.add_log("No scored candidates to rank. Skipping Ranker stage.")
        tracker.update(stage="completed", ranker={"status": "completed"})
        return {"resumes": state["resumes"]}

    # Initialize model
    try:
        llm = ChatOllama(
            model=state["ranker_model"],
            temperature=0.1,
            format="json",
            base_url=config.ollama.base_url,
        )
    except Exception as e:
        error_msg = f"Failed to initialize Ollama ranker model '{state['ranker_model']}': {str(e)}"
        tracker.add_log(error_msg)
        tracker.update(stage="failed", ranker={"status": "failed"})
        raise RuntimeError(error_msg)

    # Format candidates list for the ranker
    candidates_list = []
    for r in scored_resumes:
        candidates_list.append({
            "filename": r["filename"],
            "score": r["score"],
            "evaluation_summary": r["scorer_analysis"][:300] + "..." if r["scorer_analysis"] else ""
        })

    prompt = f"""You are an HR Director. Your task is to rank the candidates from best to worst based on the Job Description, their scores, and their evaluation summaries.

Job Description:
{state['job_description']}

Candidates List:
{json.dumps(candidates_list, indent=2)}

You must output a JSON object containing:
1. "rankings": a list of objects, each containing:
   - "filename": exact filename of the candidate.
   - "rank": the rank integer (1 for the absolute best, 2 for the second best, etc.).
   - "reasoning": 1-2 sentences comparing this candidate to others and explaining the rank.
2. "summary": a brief general summary of the ranking choices.

Valid JSON Output:"""

    db = SessionLocal()
    updated_resumes = {r["id"]: r for r in state["resumes"]}
    
    try:
        response = llm.invoke(prompt)
        result = clean_and_parse_json(response.content)
        
        rankings_list = result.get("rankings", [])
        overall_summary = result.get("summary", "Ranking completed.")
        
        tracker.add_log(f"Ranker Summary: {overall_summary}")
        
        # Build map of filename -> rank info
        rank_map = {}
        for rank_info in rankings_list:
            fname = rank_info.get("filename")
            if fname:
                rank_map[fname] = {
                    "rank": rank_info.get("rank"),
                    "reasoning": rank_info.get("reasoning", "No explanation.")
                }
                
        # If any candidate was missed in rank list, we'll sort by score as fallback
        fallback_sorted = sorted(scored_resumes, key=lambda x: x["score"] or 0, reverse=True)
        
        for i, res in enumerate(scored_resumes):
            fname = res["filename"]
            if fname in rank_map:
                rank = rank_map[fname]["rank"]
                reasoning = rank_map[fname]["reasoning"]
            else:
                # Fallback rank based on score sorting
                rank = fallback_sorted.index(res) + 1
                reasoning = "Ranked automatically using fallback score sorting."
                
            # Save to DB
            db_resume = db.query(Resume).filter(Resume.id == res["id"]).first()
            if db_resume:
                db_resume.rank = rank
                db_resume.ranker_analysis = reasoning
                db.commit()

            # Update state
            res_id = res["id"]
            updated_resumes[res_id]["rank"] = rank
            updated_resumes[res_id]["ranker_analysis"] = reasoning
            
            tracker.update(ranker={"current": i+1})

        # Update Job Status in DB
        db_job = db.query(Job).filter(Job.id == job_id).first()
        if db_job:
            db_job.status = "completed"
            db.commit()

    except Exception as e:
        error_msg = f"Error during ranking: {str(e)}"
        tracker.add_log(error_msg)
        tracker.update(stage="failed", ranker={"status": "failed"})
        
        # Mark job as failed in DB
        db_job = db.query(Job).filter(Job.id == job_id).first()
        if db_job:
            db_job.status = "failed"
            db.commit()
        db.close()
        raise RuntimeError(error_msg)

    db.close()
    tracker.update(stage="completed", ranker={"status": "completed"})
    tracker.add_log("Ranker Agent completed successfully. Shortlisting process done!")
    
    return {"resumes": list(updated_resumes.values())}

# Build StateGraph
workflow = StateGraph(AgentState)

# Add nodes
workflow.add_node("filter", filter_node)
workflow.add_node("scorer", scorer_node)
workflow.add_node("ranker", ranker_node)

# Add edges
workflow.set_entry_point("filter")
workflow.add_edge("filter", "scorer")
workflow.add_edge("scorer", "ranker")
workflow.add_edge("ranker", END)

# Compile graph
app_graph = workflow.compile()
