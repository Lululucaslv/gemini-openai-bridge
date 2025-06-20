from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import HumanMessage, SystemMessage
import os
import json
import time
from typing import List, Dict, Any, Optional
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

# Disable CORS. Do not remove this for full-stack development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows all origins
    allow_credentials=True,
    allow_methods=["*"],  # Allows all methods
    allow_headers=["*"],  # Allows all headers
)

llm = ChatGoogleGenerativeAI(
    model="gemini-1.5-flash",
    google_api_key=os.getenv("GEMINI_API_KEY"),
    temperature=0.7
)

class Feedback(BaseModel):
    id: str
    chatId: str
    userId: Optional[str] = "anonymous"
    rating: int  # 1-5 stars
    comment: Optional[str] = ""
    timestamp: int

feedback_store: List[Feedback] = []

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    action: str
    messages: Optional[List[ChatMessage]] = None
    model: Optional[str] = "gemini-pro"
    temperature: Optional[float] = 0.7
    stream: Optional[bool] = False
    chatId: Optional[str] = None
    userId: Optional[str] = None
    rating: Optional[int] = None
    comment: Optional[str] = None
    limit: Optional[int] = 50

@app.get("/healthz")
async def healthz():
    return {"status": "ok"}

@app.get("/api")
async def get_api_info():
    return {
        "message": "Gemini API Bridge is running",
        "endpoints": {
            "chat": "/api?action=chat",
            "models": "/api?action=models", 
            "feedback": "/api?action=feedback (POST)",
            "getFeedback": "/api?action=getFeedback"
        }
    }

@app.post("/api")
async def handle_api_request(request: ChatRequest):
    try:
        if request.action == "models":
            return {
                "object": "list",
                "data": [
                    {
                        "id": "gemini-pro",
                        "object": "model",
                        "created": int(time.time()),
                        "owned_by": "google"
                    },
                    {
                        "id": "gemini-pro-vision", 
                        "object": "model",
                        "created": int(time.time()),
                        "owned_by": "google"
                    }
                ]
            }
        
        elif request.action == "chat":
            if not request.messages:
                return JSONResponse(
                    status_code=400,
                    content={"error": "Messages array is required"}
                )
            
            langchain_messages = []
            for msg in request.messages:
                if msg.role == "user":
                    langchain_messages.append(HumanMessage(content=msg.content))
                elif msg.role == "system":
                    langchain_messages.append(SystemMessage(content=msg.content))
            
            chat_id = f"chatcmpl-{int(time.time() * 1000)}"
            created = int(time.time())
            
            if request.stream:
                async def generate_stream():
                    try:
                        yield f"data: {json.dumps({'id': chat_id, 'object': 'chat.completion.chunk', 'created': created, 'model': request.model, 'choices': [{'index': 0, 'delta': {'role': 'assistant'}, 'finish_reason': None}]})}\n\n"
                        
                        async for chunk in llm.astream(langchain_messages):
                            if chunk.content:
                                stream_chunk = {
                                    "id": chat_id,
                                    "object": "chat.completion.chunk",
                                    "created": created,
                                    "model": request.model,
                                    "choices": [{
                                        "index": 0,
                                        "delta": {
                                            "role": "assistant",
                                            "content": chunk.content
                                        },
                                        "finish_reason": None
                                    }]
                                }
                                yield f"data: {json.dumps(stream_chunk)}\n\n"
                        
                        final_chunk = {
                            "id": chat_id,
                            "object": "chat.completion.chunk", 
                            "created": created,
                            "model": request.model,
                            "choices": [{
                                "index": 0,
                                "delta": {},
                                "finish_reason": "stop"
                            }]
                        }
                        yield f"data: {json.dumps(final_chunk)}\n\n"
                        yield "data: [DONE]\n\n"
                        
                    except Exception as e:
                        error_chunk = {
                            "id": chat_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": request.model,
                            "choices": [{
                                "index": 0,
                                "delta": {},
                                "finish_reason": "stop"
                            }],
                            "error": str(e)
                        }
                        yield f"data: {json.dumps(error_chunk)}\n\n"
                        yield "data: [DONE]\n\n"
                
                return StreamingResponse(
                    generate_stream(),
                    media_type="text/event-stream",
                    headers={
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive"
                    }
                )
            else:
                response = await llm.ainvoke(langchain_messages)
                text = response.content
                
                return {
                    "id": chat_id,
                    "object": "chat.completion",
                    "created": created,
                    "model": request.model,
                    "choices": [{
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": text
                        },
                        "finish_reason": "stop"
                    }],
                    "usage": {
                        "prompt_tokens": sum(len(msg.content) for msg in request.messages),
                        "completion_tokens": len(text),
                        "total_tokens": sum(len(msg.content) for msg in request.messages) + len(text)
                    }
                }
        
        elif request.action == "feedback":
            if not request.chatId or not request.rating or request.rating < 1 or request.rating > 5:
                return JSONResponse(
                    status_code=400,
                    content={"error": "chatId and rating (1-5) are required"}
                )
            
            feedback = Feedback(
                id=f"feedback-{int(time.time() * 1000)}-{hex(int(time.time() * 1000000) % 1000000)[2:]}",
                chatId=request.chatId,
                userId=request.userId or "anonymous",
                rating=request.rating,
                comment=request.comment or "",
                timestamp=int(time.time() * 1000)
            )
            
            feedback_store.append(feedback)
            
            return {
                "success": True,
                "feedback": feedback.dict(),
                "message": "Feedback submitted successfully"
            }
        
        elif request.action == "getFeedback":
            feedbacks = feedback_store
            
            if request.chatId:
                feedbacks = [f for f in feedback_store if f.chatId == request.chatId]
            
            feedbacks = sorted(feedbacks, key=lambda x: x.timestamp, reverse=True)[:request.limit]
            
            if feedbacks:
                avg_rating = sum(f.rating for f in feedbacks) / len(feedbacks)
                rating_dist = {str(i): len([f for f in feedbacks if f.rating == i]) for i in range(1, 6)}
            else:
                avg_rating = 0
                rating_dist = {str(i): 0 for i in range(1, 6)}
            
            stats = {
                "total": len(feedbacks),
                "averageRating": avg_rating,
                "ratingDistribution": rating_dist
            }
            
            return {
                "feedbacks": [f.dict() for f in feedbacks],
                "stats": stats,
                "total": len(feedback_store)
            }
        
        else:
            return JSONResponse(
                status_code=400,
                content={"error": "Invalid action. Use 'chat', 'models', 'feedback', or 'getFeedback'"}
            )
    
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={
                "error": "Internal server error",
                "details": str(e)
            }
        )
