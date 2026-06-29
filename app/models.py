import datetime
import uuid
from sqlalchemy import Column, String, Integer, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from app.database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    full_name = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    # Relationships
    jobs = relationship("Job", back_populates="owner", cascade="all, delete-orphan")

class Job(Base):
    __tablename__ = "jobs"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    title = Column(String, nullable=False)
    jd_text = Column(Text, nullable=False)
    filter_model = Column(String, nullable=False)
    scorer_model = Column(String, nullable=False)
    ranker_model = Column(String, nullable=False)
    embedding_model = Column(String, nullable=False)
    status = Column(String, default="pending")  # pending, running, completed, failed
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    # Relationships
    owner = relationship("User", back_populates="jobs")
    resumes = relationship("Resume", back_populates="job", cascade="all, delete-orphan")

class Resume(Base):
    __tablename__ = "resumes"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    job_id = Column(String, ForeignKey("jobs.id"), nullable=False)
    filename = Column(String, nullable=False)
    text = Column(Text, nullable=False)
    
    # Processing stage outputs
    relevant = Column(Boolean, nullable=True)
    filter_analysis = Column(Text, nullable=True)
    
    score = Column(Integer, nullable=True)
    scorer_analysis = Column(Text, nullable=True)
    
    rank = Column(Integer, nullable=True)
    ranker_analysis = Column(Text, nullable=True)
    
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    # Relationships
    job = relationship("Job", back_populates="resumes")
