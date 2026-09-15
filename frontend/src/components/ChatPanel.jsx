import React, { useState } from 'react';
import axios from 'axios';
import { MessageList } from '@/components/agent-elements/message-list';
import { InputBar } from '@/components/agent-elements/input-bar';
import { Trash2, AlertTriangle, Sparkles } from 'lucide-react';

export function ChatPanel({
  selectedDoc,
  apiUrl,
  hasSpeechRecognition,
  voiceLang,
  onCycleLang,
  isListening,
  toggleListen,
  voiceError,
  hasTTS,
  speakingId,
  onSpeak,
  onStopSpeaking
}) {
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const suggestedQuestions = selectedDoc?.structuredData?.suggested_questions || [
    "What is the main subject of this document?",
    "What are the key dates mentioned?",
    "What immediate action is required?"
  ];

  const handleSendMessage = async (textToSend) => {
    const question = (textToSend || inputMessage).trim();
    if (!question || !selectedDoc || isLoading) return;

    const userMsg = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: question
    };

    setMessages(prev => [...prev, userMsg]);
    setInputMessage('');
    setIsLoading(true);

    try {
      const response = await axios.post(`${apiUrl}/chat`, {
        documentId: selectedDoc.id,
        question
      });

      const assistantMsg = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: response.data.answer || 'No answer available.',
        source: response.data.source || 'document',
        unverifiedFigure: Boolean(response.data.unverifiedFigure),
        supporting_quote: response.data.supporting_quote || ''
      };

      setMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
      console.error('Chat error:', err);
      const errorMsg = {
        id: `assistant-err-${Date.now()}`,
        role: 'assistant',
        content: 'Unable to reach the assistant right now. Please verify your connection or try asking again.',
        source: 'general',
        unverifiedFigure: false
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearHistory = () => {
    if (onStopSpeaking) onStopSpeaking();
    setMessages([]);
  };

  // Convert internal speakingId check for MessageList
  const speakingIndex = speakingId && speakingId.startsWith('chat_')
    ? parseInt(speakingId.replace('chat_', ''), 10)
    : null;

  const handleSpeakItem = (content, index) => {
    if (onSpeak) {
      const lang = /[\u0900-\u097F]/.test(content) ? 'hi-IN' : 'en-IN';
      onSpeak(content, lang, `chat_${index}`);
    }
  };

  return (
    <div className="flex flex-col h-full max-h-full overflow-hidden bg-[var(--color-clawde-offwhite)]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2D9CC] shrink-0">
        <div>
          <h2 className="text-xl font-serif font-bold text-[var(--color-clawde-ink)] flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-[var(--color-clawde-brass)]" />
            Legal Assistant
          </h2>
          <p className="text-[11px] font-sans text-gray-500 uppercase tracking-wider">
            Grounded in case record with general guidance fallback
          </p>
        </div>

        {messages.length > 0 && (
          <button
            type="button"
            onClick={handleClearHistory}
            className="p-1.5 rounded-lg text-gray-400 hover:text-[var(--color-clawde-oxblood)] hover:bg-gray-100 transition-colors"
            title="Clear chat history"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Voice input banner/controls if available */}
      {hasSpeechRecognition && (
        <div className="px-6 py-1.5 bg-[var(--color-clawde-parchment)]/60 border-b border-[#E2D9CC] flex items-center justify-between text-xs text-gray-600">
          <span className="flex items-center gap-1.5">
            Voice language: <strong className="font-semibold text-[var(--color-clawde-ink)]">{voiceLang}</strong>
          </span>
          <button
            type="button"
            onClick={onCycleLang}
            className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border border-[#E2D9CC] hover:bg-white text-[var(--color-clawde-ink)]"
          >
            Switch (EN/HI/MR)
          </button>
        </div>
      )}

      {voiceError && (
        <div className="mx-4 mt-2 px-3 py-1.5 bg-red-50 border border-red-200 text-xs text-[var(--color-clawde-oxblood)] rounded-md flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{voiceError}</span>
        </div>
      )}

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto flex flex-col justify-between">
        {messages.length === 0 ? (
          <div className="p-6 flex flex-col items-center justify-center text-center my-auto">
            <div className="w-12 h-12 rounded-full bg-[var(--color-clawde-parchment)] border border-[#E2D9CC] flex items-center justify-center text-[var(--color-clawde-brass)] mb-3">
              <Sparkles className="w-6 h-6" />
            </div>
            <h3 className="font-serif text-base font-bold text-[var(--color-clawde-ink)] mb-1">
              Ask about {selectedDoc?.structuredData?.doc_type || 'this document'}
            </h3>
            <p className="text-xs text-gray-500 max-w-sm mb-6">
              You can ask questions about timeline, parties, legal sections, or general Indian legal procedure.
            </p>
          </div>
        ) : (
          <MessageList
            messages={messages}
            isLoading={isLoading}
            onSpeak={handleSpeakItem}
            speakingIndex={speakingIndex}
            onStopSpeech={onStopSpeaking}
          />
        )}
      </div>

      {/* Input Bar Area */}
      <div className="p-4 border-t border-[#E2D9CC] bg-white shrink-0">
        <InputBar
          value={inputMessage}
          onChange={setInputMessage}
          onSend={handleSendMessage}
          isLoading={isLoading}
          placeholder="Ask in English, हिंदी, or मराठी..."
          suggestions={messages.length === 0 ? suggestedQuestions : []}
          onSelectSuggestion={(s) => handleSendMessage(s)}
          isListening={isListening}
          onToggleSpeech={hasSpeechRecognition ? toggleListen : undefined}
        />
      </div>
    </div>
  );
}
