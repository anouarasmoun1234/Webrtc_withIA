# lc_engine.py
# 
# 
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain.memory import ConversationBufferMemory
from langchain.chains import ConversationChain
import os
from tools.search_tool import web_search  
from langchain.tools import Tool
from langchain.agents import initialize_agent, AgentType


# --- déclencheur recherche Web ----------------------------------
TRIGGERS = [
    "weather", "météo", "distance", "how far", "train",
    "schedule", "horaire", "population", "capital",
    "definition", "define", "who", "when", "where",
    "what is", "price", "time", "heure"
]

def maybe_web_search(text: str) -> str:
    """
    Si la question contient un mot-clé « temps réel », on appelle SerpApi
    et on renvoie 3-6 lignes (titre + extrait). Sinon chaîne vide.
    """
    low = text.lower()
    if any(tok in low for tok in TRIGGERS) and len(low.split()) >= 3:
        try:
            return web_search(text, k=6)
        except Exception as e:
            return f"(Web search unavailable: {e})"
    return ""
# ----------------------------------------------------------------

def build_chain():
    llm = ChatGoogleGenerativeAI(
        model="models/gemini-1.5-flash",
        temperature=0.3,
        google_api_key=os.getenv("GOOGLE_API_KEY"),
        max_tokens=256,
    )
# ---------- Tools ----------
    tools = [
        Tool(
            name="WebSearch",
            func=web_search,
            description=(
                "Useful when you need to look up information on the Web, "
                "for example weather, distance, definitions, train schedule, etc. "
                "Input should be the search query in plain language."
            )
        )
    ]
    

    # La mémoire renvoie 'history'
    memory = ConversationBufferMemory(
        memory_key="history",
        return_messages=True
    )

    # Le prompt doit consommer {history} ET {input}
    prompt = ChatPromptTemplate.from_messages([
        ("system",
         "You are Lara, a helpful AI inside a video-conference. "
         "Answer briefly and clearly."),
        MessagesPlaceholder(variable_name="history"),
        ("human", "{input}")          # <- clé attendue par ConversationChain
    ])

    return ConversationChain(llm=llm, prompt=prompt, memory=memory)

chain = build_chain()

def run_lara(question: str, recent_context: str = "") -> str:
    # 1) Contexte réunion → mémoire
    if recent_context:
        chain.memory.chat_memory.add_user_message(recent_context)

    # 2) Recherche Web si besoin
    web_ctx = maybe_web_search(question)
    if web_ctx:
        user_input = (
            f"{question}\n\n"
            "=== Web search results ===\n"
            f"{web_ctx}\n"
            "=========================="
        )
    else:
        user_input = question

    # 3) Appel du LLM
    return chain({"input": user_input})["response"]
