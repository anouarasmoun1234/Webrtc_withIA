# lc_engine.py
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain.memory import ConversationBufferMemory
from langchain.chains import ConversationChain
import os

def build_chain():
    llm = ChatGoogleGenerativeAI(
        model="models/gemini-1.5-flash",
        temperature=0.3,
        google_api_key=os.getenv("GOOGLE_API_KEY"),
        max_tokens=256,
    )

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
    # On alimente la mémoire avec le contexte récent (optionnel)
    if recent_context:
        chain.memory.chat_memory.add_user_message(recent_context)

    # ConversationChain attend un dict {"input": "..."}
    return chain({"input": question})["response"]
