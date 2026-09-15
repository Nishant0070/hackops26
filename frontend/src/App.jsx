import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import {
  Scale,
  MessageSquare,
  X,
  ChevronDown,
  Volume2,
  Square,
  Share2,
  AlertTriangle,
  Calendar,
  Loader2
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import { motion, AnimatePresence } from 'framer-motion';
import { Toaster, toast } from 'sonner';
import { ChatPanel } from '@/components/ChatPanel';
import { PipelineProgress } from '@/components/PipelineProgress';

// Use CDN for worker to avoid bundler issues
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5001/api';

function App() {
  const [documents, setDocuments] = useState([]);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [currentUploadId, setCurrentUploadId] = useState(null);

  // Summary language segmented control ('en' | 'hi') persisted to localStorage
  const [summaryLang, setSummaryLang] = useState(() => {
    return localStorage.getItem('clawde_summary_lang') || 'en';
  });

  // Collapsible extracted text section
  const [extractedOpen, setExtractedOpen] = useState(false);

  // Slide-in chat panel state
  const [chatOpen, setChatOpen] = useState(false);
  const [hasOpenedChat, setHasOpenedChat] = useState(false);

  // Speech synthesis
  const [speakingId, setSpeakingId] = useState(null);
  const hasTTS = typeof window !== 'undefined' && 'speechSynthesis' in window;

  // Speech recognition (voice input)
  const [isListening, setIsListening] = useState(false);
  const [voiceLang, setVoiceLang] = useState('en-IN'); // en-IN | hi-IN | mr-IN
  const [voiceError, setVoiceError] = useState(null);
  const recognitionRef = useRef(null);
  const hasSpeechRecognition = typeof window !== 'undefined' &&
    ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window);

  const [bnsMap, setBnsMap] = useState([]);

  useEffect(() => {
    fetchDocuments();
    fetchBnsMap();
  }, []);

  // Keyboard shortcut: close chat with Escape
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && chatOpen) {
        setChatOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [chatOpen]);

  const fetchDocuments = async () => {
    try {
      const response = await axios.get(`${API_URL}/documents`);
      setDocuments(response.data);
    } catch (error) {
      console.error('Failed to fetch documents', error);
    }
  };

  const fetchBnsMap = async () => {
    try {
      const response = await axios.get(`${API_URL}/bns-map`);
      setBnsMap(response.data);
    } catch (error) {
      console.error('Failed to load BNS map', error);
    }
  };

  const initSpeechRecognition = () => {
    if (!hasSpeechRecognition) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = voiceLang;

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      window.dispatchEvent(new CustomEvent('clawde:speech-result', { detail: transcript }));
      setVoiceError(null);
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      setIsListening(false);
      if (event.error === 'not-allowed') {
        setVoiceError('Microphone access denied. Please allow mic access in your browser settings.');
      } else if (event.error === 'no-speech') {
        setVoiceError('No speech detected. Try again.');
      } else {
        setVoiceError(`Voice error: ${event.error}`);
      }
    };

    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
  };

  useEffect(() => {
    initSpeechRecognition();
  }, []);

  useEffect(() => {
    if (recognitionRef.current) {
      recognitionRef.current.lang = voiceLang;
    }
  }, [voiceLang]);

  const toggleListen = () => {
    if (!hasSpeechRecognition || !recognitionRef.current) return;
    setVoiceError(null);
    if (isListening) {
      recognitionRef.current.stop();
    } else {
      try {
        recognitionRef.current.lang = voiceLang;
        recognitionRef.current.start();
        setIsListening(true);
      } catch (e) {
        console.error('Could not start recognition:', e);
        setVoiceError('Could not start microphone. Try tapping again.');
        setIsListening(false);
      }
    }
  };

  const cycleLang = () => {
    const langs = ['en-IN', 'hi-IN', 'mr-IN'];
    const labels = { 'en-IN': 'EN', 'hi-IN': 'HI', 'mr-IN': 'MR' };
    const next = langs[(langs.indexOf(voiceLang) + 1) % langs.length];
    setVoiceLang(next);
    return labels[next];
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const uploadId = `up_${Date.now()}`;
    setCurrentUploadId(uploadId);
    setUploading(true);

    const formData = new FormData();
    formData.append('fileName', file.name);
    formData.append('uploadId', uploadId);
    formData.append('pages', file, file.name);

    try {
      const response = await axios.post(`${API_URL}/upload`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          'X-Upload-ID': uploadId
        }
      });

      setSelectedDoc(response.data);
      setExtractedOpen(false);
      setHasOpenedChat(false);
      fetchDocuments();
    } catch (error) {
      console.error('Upload failed', error);
      alert(error.response?.data?.error || 'Failed to process document');
    } finally {
      setUploading(false);
      setCurrentUploadId(null);
    }
  };

  const handleDocSelect = (doc) => {
    setSelectedDoc(doc);
    setExtractedOpen(false);
    setHasOpenedChat(false);
    stopSpeaking();
  };

  // TTS helpers
  const speak = (text, lang, id) => {
    if (!hasTTS) return;
    window.speechSynthesis.cancel();
    if (speakingId === id) {
      setSpeakingId(null);
      return;
    }
    const utter = new window.SpeechSynthesisUtterance(text);
    utter.lang = lang;
    const voices = window.speechSynthesis.getVoices();
    const match = voices.find(v => v.lang === lang) ||
                  (lang === 'mr-IN' ? voices.find(v => v.lang === 'hi-IN') : null);
    if (match) utter.voice = match;
    utter.onend = () => setSpeakingId(null);
    utter.onerror = () => setSpeakingId(null);
    setSpeakingId(id);
    window.speechSynthesis.speak(utter);
  };

  const stopSpeaking = () => {
    if (hasTTS) window.speechSynthesis.cancel();
    setSpeakingId(null);
  };

  const handleSetSummaryLang = (lang) => {
    setSummaryLang(lang);
    localStorage.setItem('clawde_summary_lang', lang);
    stopSpeaking();
  };

  const shareOnWhatsApp = (doc, lang = 'en') => {
    const bullets = lang === 'hi'
      ? (doc.structuredData?.summary_hi || []).join('\n• ')
      : (doc.structuredData?.summary_en || []).join('\n• ');
    const action = doc.structuredData?.action_required || '';
    const msg = `*Case Summary — Clawde Justice Assistant*\n\n${action ? `⚠️ ${action}\n\n` : ''}• ${bullets}\n\n_This summary was generated by Clawde. Always verify details with a qualified advocate._`;
    try {
      const opened = window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank', 'noopener');
      if (!opened) {
        navigator.clipboard.writeText(msg);
        toast.success(lang === 'hi' ? 'सारांश क्लिपबोर्ड पर कॉपी किया गया!' : 'Summary copied to clipboard!');
      }
    } catch (e) {
      navigator.clipboard.writeText(msg);
      toast.success(lang === 'hi' ? 'सारांश क्लिपबोर्ड पर कॉपी किया गया!' : 'Summary copied to clipboard!');
    }
  };

  const highlightUncertainSpans = (text, spans) => {
    if (!text) return "";
    if (!spans || spans.length === 0) return text;
    let highlightedText = text;
    spans.forEach(span => {
      if (span && span.length > 3) {
        highlightedText = highlightedText.split(span).join(`<span class="bg-clawde-brass/30 border-b border-clawde-brass text-clawde-ink">${span}</span>`);
      }
    });
    return highlightedText;
  };

  // Extract parties helper
  const parties = selectedDoc?.structuredData?.parties || [];
  const filedBy = parties.filter(p => /petitioner|appellant|complainant|plaintiff/i.test(p.role)).map(p => p.name).join(', ') || parties[0]?.name || 'N/A';
  const filedAgainst = parties.filter(p => /respondent|accused|defendant/i.test(p.role)).map(p => p.name).join(', ') || parties[1]?.name || 'N/A';
  const keyDates = selectedDoc?.structuredData?.key_dates || [];
  const nextHearingDate = keyDates.find(d => /next|hearing|listed|adjourn/i.test(d.event))?.date || 'None scheduled';

  // Law update citations mapping
  const docCitations = selectedDoc?.structuredData?.old_law_citations || [];
  const mappedCitations = docCitations
    .map(c => bnsMap.find(m => m.old === c.citation || c.citation === m.old || (m.old && c.citation && c.citation.includes(m.old))))
    .filter(Boolean);
  const uniqueMapped = Array.from(new Map(mappedCitations.map(m => [m.old, m])).values());

  const unmappedCitations = docCitations.filter(c =>
    !bnsMap.some(m => m.old === c.citation || (m.old && c.citation && c.citation.includes(m.old)))
  );
  const uniqueUnmapped = Array.from(new Map(unmappedCitations.map(u => [u.citation, u])).values());

  const bullets = summaryLang === 'hi'
    ? (selectedDoc?.structuredData?.summary_hi || [])
    : (selectedDoc?.structuredData?.summary_en || []);

  const shouldPulseFab = Boolean(
    selectedDoc?.structuredData?.suggested_questions?.length > 0 && !hasOpenedChat
  );

  return (
    <div className="min-h-screen font-sans flex flex-col md:flex-row bg-clawde-ink text-clawde-charcoal overflow-hidden">
      <Toaster position="bottom-center" />

      {/* 1. LEFT PANEL (Case Browser) */}
      <div className="w-full md:w-3/12 lg:w-[22%] bg-clawde-ink border-r border-white/10 flex flex-col h-screen overflow-y-auto shrink-0 z-20">
        <div className="p-6 text-clawde-parchment">
          <div className="brand-mark flex items-center gap-3">
            <Scale className="w-7 h-7 text-clawde-brass" strokeWidth={1.5} />
            <div>
              <h1 className="text-xl font-serif font-semibold text-clawde-parchment tracking-tight">Clawde</h1>
              <p className="text-[10px] font-sans text-clawde-parchment/50 uppercase tracking-[0.15em]">Justice Assistant</p>
            </div>
          </div>
        </div>

        <div className="p-5">
          <div className="relative">
            <input 
              type="file" 
              accept="image/*,application/pdf" 
              onChange={handleFileUpload}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              disabled={uploading}
            />
            <button 
              type="button"
              className={`w-full py-3 px-4 text-[12px] font-sans font-semibold uppercase tracking-[0.1em] transition-colors border ${uploading ? 'bg-clawde-ink border-white/20 text-white/50 cursor-wait' : 'bg-clawde-parchment text-clawde-ink border-clawde-parchment hover:bg-white'}`}
            >
              {uploading ? 'Processing Document...' : 'Upload New Document'}
            </button>
          </div>
        </div>

        <div className="flex-1 p-5 flex flex-col gap-3">
          <h3 className="text-[10px] font-sans font-bold text-clawde-parchment/50 uppercase tracking-[0.18em] mb-2">Case Files</h3>
          {documents.length === 0 ? (
            <p className="text-sm text-clawde-parchment/60 font-serif italic">No documents uploaded. Add a scan to get started.</p>
          ) : (
            documents.map(doc => (
              <div 
                key={doc.id} 
                onClick={() => handleDocSelect(doc)}
                className={`p-4 border cursor-pointer transition-all ${selectedDoc?.id === doc.id ? 'border-clawde-brass bg-clawde-ink shadow-sm' : 'border-white/10 hover:border-white/30 bg-clawde-ink/50'}`}
              >
                <div className="flex justify-between items-start mb-1">
                  <span className="font-bold text-sm truncate pr-2 text-clawde-parchment font-sans">{doc.structuredData?.case_number || 'No Case Number'}</span>
                </div>
                <p className="text-[10px] text-clawde-brass uppercase tracking-wider font-semibold mb-1">{doc.structuredData?.doc_type || 'Legal Document'}</p>
                <p className="text-xs text-clawde-parchment/40 truncate font-serif italic">{doc.fileName}</p>
              </div>
            ))
          )}
        </div>
        
        <div className="p-5 text-[10px] leading-relaxed text-clawde-parchment/40 border-t border-white/10 font-sans mt-auto">
          This tool provides information, not legal advice. Verify all details with a qualified advocate.
        </div>
      </div>

      {/* Main Content Area */}
      {uploading && currentUploadId ? (
        <div className="flex-1 h-screen flex flex-col items-center justify-center bg-clawde-parchment p-8">
          <PipelineProgress 
            uploadId={currentUploadId}
            apiUrl={API_URL}
            onComplete={() => fetchDocuments()}
          />
        </div>
      ) : !selectedDoc ? (
        /* Empty State (5.4) */
        <div className="flex-1 h-screen flex flex-col items-center justify-center bg-clawde-parchment p-8 text-center">
          <Scale className="w-24 h-24 text-clawde-brass animate-scale-idle mb-6" strokeWidth={1.2} />
          <h2 className="text-2xl font-serif text-clawde-ink mb-2">Upload a court document</h2>
          <p className="text-[13px] font-sans text-clawde-ink/60 max-w-[36ch] leading-relaxed">
            Clawde reads it, explains what it means in plain English or Hindi, and answers your questions about it.
          </p>
        </div>
      ) : (
        /* Single Scroll Restructured Layout (5.2) */
        <div className="flex-1 h-screen overflow-y-auto bg-clawde-parchment relative scroll-smooth">
          
          {/* Section 1 — Hero card */}
          <div className="bg-clawde-ink text-clawde-parchment pt-10 pb-8 px-10">
            {selectedDoc.structuredData?.action_required ? (
              <div className="bg-clawde-oxblood text-white p-5 mb-6 border-l-4 border-clawde-brass shadow-sm">
                <p className="text-[10px] font-sans font-bold uppercase tracking-[0.18em] text-white/70 mb-1">
                  Urgent Action Required
                </p>
                <h2 className="text-lg font-serif font-bold leading-snug">
                  {selectedDoc.structuredData.action_required}
                </h2>
              </div>
            ) : (
              <p className="text-clawde-parchment/50 text-[13px] font-sans mb-4 tracking-wide">
                Summary of your document
              </p>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-2 border-t border-white/10">
              <div>
                <p className="text-[11px] font-sans font-semibold uppercase tracking-[0.15em] text-clawde-parchment/50 mb-1">
                  Court
                </p>
                <p className="text-[15px] font-serif text-clawde-parchment truncate">
                  {selectedDoc.structuredData?.court_name || "Unknown Court"}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-sans font-semibold uppercase tracking-[0.15em] text-clawde-parchment/50 mb-1">
                  Case Number
                </p>
                <p className="text-[15px] font-serif text-clawde-parchment truncate">
                  {selectedDoc.structuredData?.case_number || "N/A"}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-sans font-semibold uppercase tracking-[0.15em] text-clawde-parchment/50 mb-1">
                  Document Type
                </p>
                <p className="text-[15px] font-serif text-clawde-parchment truncate">
                  {selectedDoc.structuredData?.doc_type || "Legal Document"}
                </p>
              </div>
            </div>
          </div>

          {/* Section 2 — Summary */}
          <div className="py-12 px-10 bg-clawde-parchment">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[10px] font-sans font-bold uppercase tracking-[0.18em] text-clawde-ink/60">
                In Plain Language
              </span>
              {hasTTS && bullets.length > 0 && (
                <button
                  type="button"
                  onClick={() => speak(bullets.join(summaryLang === 'hi' ? '। ' : '. '), summaryLang === 'hi' ? 'hi-IN' : 'en-IN', 'summary')}
                  className="flex items-center gap-1.5 text-clawde-ink/50 hover:text-clawde-oxblood transition-colors text-[12px] font-sans font-semibold uppercase tracking-[0.1em]"
                  title={speakingId === 'summary' ? 'Stop listening' : 'Read aloud'}
                >
                  {speakingId === 'summary' ? <Square className="w-3.5 h-3.5 text-clawde-oxblood" /> : <Volume2 className="w-3.5 h-3.5" />}
                  <span>{speakingId === 'summary' ? 'Stop' : 'Listen'}</span>
                </button>
              )}
            </div>

            {/* Segmented Control */}
            <div className="flex items-center gap-2 mb-6">
              <button
                type="button"
                onClick={() => handleSetSummaryLang('en')}
                className={`px-4 py-1.5 rounded-full text-[12px] font-sans font-semibold uppercase tracking-[0.1em] transition-all ${summaryLang === 'en' ? 'bg-clawde-ink text-clawde-parchment shadow-sm' : 'bg-clawde-ink/5 text-clawde-ink/70 hover:bg-clawde-ink/10'}`}
              >
                English
              </button>
              <button
                type="button"
                onClick={() => handleSetSummaryLang('hi')}
                className={`px-4 py-1.5 rounded-full text-[12px] font-sans font-semibold uppercase tracking-[0.1em] transition-all ${summaryLang === 'hi' ? 'bg-clawde-ink text-clawde-parchment shadow-sm' : 'bg-clawde-ink/5 text-clawde-ink/70 hover:bg-clawde-ink/10'}`}
              >
                हिंदी
              </button>
            </div>

            {/* Bulleted List */}
            {bullets.length === 0 ? (
              <p className="text-sm font-serif italic text-clawde-ink/50">Summary not available.</p>
            ) : (
              <ul className={`list-disc pl-5 space-y-3 max-w-[75ch] ${summaryLang === 'hi' ? 'font-devanagari text-[17px] leading-[1.85]' : 'font-serif text-[15px] leading-[1.8]'} text-clawde-charcoal`}>
                {bullets.map((bullet, i) => (
                  <li key={i} className="pl-1">{bullet}</li>
                ))}
              </ul>
            )}

            {/* WhatsApp Share Buttons */}
            <div className="flex flex-wrap gap-3 pt-6 mt-4">
              <button
                type="button"
                onClick={() => shareOnWhatsApp(selectedDoc, 'en')}
                className="flex items-center gap-2 px-4 py-2 border border-clawde-ink/20 bg-white text-clawde-ink text-[12px] font-sans font-semibold uppercase tracking-[0.1em] hover:bg-[#25D366] hover:text-white hover:border-[#25D366] transition-colors shadow-sm"
                title="Share English summary on WhatsApp"
              >
                <Share2 className="w-3.5 h-3.5" /> Share in English
              </button>
              <button
                type="button"
                onClick={() => shareOnWhatsApp(selectedDoc, 'hi')}
                className="flex items-center gap-2 px-4 py-2 border border-clawde-ink/20 bg-white text-clawde-ink text-[12px] font-sans font-semibold uppercase tracking-[0.1em] hover:bg-[#25D366] hover:text-white hover:border-[#25D366] transition-colors shadow-sm font-devanagari"
                title="Share Hindi summary on WhatsApp"
              >
                <Share2 className="w-3.5 h-3.5" /> हिंदी में शेयर करें
              </button>
            </div>
          </div>

          {/* Section 3 — Key facts */}
          <div className="py-12 px-10 bg-clawde-offwhite">
            <h3 className="text-[10px] font-sans font-bold uppercase tracking-[0.18em] text-clawde-ink/50 mb-8">
              Key Facts
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-y-8 gap-x-12 max-w-4xl">
              <div>
                <p className="text-[11px] font-sans font-semibold uppercase tracking-[0.15em] text-clawde-ink/50 mb-1.5">
                  Court
                </p>
                <p className="text-[16px] font-serif text-clawde-charcoal">
                  {selectedDoc.structuredData?.court_name || "Unknown Court"}
                </p>
              </div>

              <div>
                <p className="text-[11px] font-sans font-semibold uppercase tracking-[0.15em] text-clawde-ink/50 mb-1.5">
                  Case Number
                </p>
                <p className="text-[16px] font-serif text-clawde-charcoal">
                  {selectedDoc.structuredData?.case_number || "N/A"}
                </p>
              </div>

              <div>
                <p className="text-[11px] font-sans font-semibold uppercase tracking-[0.15em] text-clawde-ink/50 mb-1.5">
                  Document Type
                </p>
                <p className="text-[16px] font-serif text-clawde-charcoal">
                  {selectedDoc.structuredData?.doc_type || "N/A"}
                </p>
              </div>

              <div>
                <p className="text-[11px] font-sans font-semibold uppercase tracking-[0.15em] text-clawde-ink/50 mb-1.5">
                  Next Hearing
                </p>
                <p className="text-[16px] font-serif text-clawde-charcoal">
                  {nextHearingDate}
                </p>
              </div>

              <div>
                <p className="text-[11px] font-sans font-semibold uppercase tracking-[0.15em] text-clawde-ink/50 mb-1.5">
                  Filed By
                </p>
                <p className="text-[16px] font-serif text-clawde-charcoal">
                  {filedBy}
                </p>
              </div>

              <div>
                <p className="text-[11px] font-sans font-semibold uppercase tracking-[0.15em] text-clawde-ink/50 mb-1.5">
                  Filed Against
                </p>
                <p className="text-[16px] font-serif text-clawde-charcoal">
                  {filedAgainst}
                </p>
              </div>
            </div>
          </div>

          {/* Section 4 — Law update notice */}
          {(uniqueMapped.length > 0 || uniqueUnmapped.length > 0) && (
            <div className="py-8 px-10 bg-clawde-parchment">
              {uniqueMapped.length > 0 && (
                <div className="bg-clawde-oxblood/10 border-l-4 border-clawde-oxblood p-5 rounded-sm">
                  <h4 className="text-clawde-oxblood font-bold flex items-center gap-2 mb-2 text-[11px] font-sans uppercase tracking-[0.15em]">
                    <AlertTriangle className="w-4 h-4 text-clawde-oxblood shrink-0" /> Law Update Notice
                  </h4>
                  <div className="text-sm text-clawde-ink mt-2 font-sans space-y-1.5">
                    {uniqueMapped.map((m, i) => (
                      <p key={i} className="text-sm">
                        This document cites <strong>{m.old}</strong> ({m.offence}). Since 1 July 2024, the corresponding provision is <strong>{m.new}</strong>.
                      </p>
                    ))}
                    <p className="text-xs text-clawde-ink/80 mt-3 border-t border-clawde-oxblood/20 pt-2 font-serif italic">
                      Which law applies depends on the date of the offence, not the date of the document. Offences before 1 July 2024 are still tried under the IPC.
                    </p>
                  </div>
                </div>
              )}

              {uniqueUnmapped.length > 0 && (
                <div className="mt-4 p-4 border border-clawde-ink/10 bg-white/60 rounded-sm">
                  <p className="text-[10px] font-sans font-bold uppercase tracking-[0.18em] text-clawde-ink/50 mb-2">
                    Not Checked Against 2024 Criminal Laws
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {uniqueUnmapped.map((u, i) => (
                      <span key={i} className="text-xs font-sans px-2.5 py-1 bg-clawde-ink/5 text-clawde-charcoal border border-clawde-ink/10">
                        {u.citation}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Section 5 — Timeline strip */}
          <div className="py-12 px-10 bg-clawde-parchment">
            <h3 className="text-[10px] font-sans font-bold uppercase tracking-[0.18em] text-clawde-ink/50 mb-6">
              Dates That Matter
            </h3>

            {keyDates.length === 0 ? (
              <p className="text-sm font-serif italic text-clawde-ink/50">No key dates extracted from this document.</p>
            ) : (
              <div className="flex gap-6 overflow-x-auto pb-4 no-scrollbar items-start">
                {keyDates.map((kd, idx) => (
                  <div key={idx} className="shrink-0 min-w-[220px] max-w-[280px] flex flex-col gap-1.5 relative">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="w-2.5 h-2.5 rounded-full bg-clawde-oxblood shrink-0" />
                      <span className="h-[1px] bg-clawde-ink/20 flex-1" />
                    </div>
                    <span className="font-sans font-bold text-sm text-clawde-ink tracking-tight flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5 text-clawde-ink/40" /> {kd.date}
                    </span>
                    <span className="font-serif italic text-sm text-clawde-charcoal leading-relaxed">
                      {kd.event}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Section 6 — Extracted text (collapsible) */}
          <div className="py-8 px-10 bg-clawde-offwhite">
            <button
              type="button"
              onClick={() => setExtractedOpen(prev => !prev)}
              className="w-full flex items-center justify-between text-left group"
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-sans font-bold uppercase tracking-[0.18em] text-clawde-ink/50">
                  Extracted Text
                </span>
                {selectedDoc.structuredData?.uncertain_spans?.length > 0 && (
                  <span className="text-[10px] font-sans font-semibold uppercase tracking-wider text-clawde-brass bg-clawde-brass/10 px-2 py-0.5 border border-clawde-brass/30">
                    {selectedDoc.structuredData.uncertain_spans.length} uncertain words
                  </span>
                )}
              </div>
              <ChevronDown className={`w-4 h-4 text-clawde-ink/50 transition-transform ${extractedOpen ? 'rotate-180' : ''}`} />
            </button>

            {extractedOpen && (
              <div className="mt-6 font-serif text-[15px] leading-[1.8] text-clawde-charcoal whitespace-pre-wrap max-w-[75ch] text-justify">
                <div dangerouslySetInnerHTML={{ __html: highlightUncertainSpans(selectedDoc.structuredData?.raw_text, selectedDoc.structuredData?.uncertain_spans) }} />
              </div>
            )}
          </div>

          {/* Section 7 — Bottom breathing space (96px) */}
          <div className="h-24 bg-clawde-parchment w-full" />

          {/* Floating Action Button (FAB) for Chat */}
          <button
            type="button"
            onClick={() => {
              setChatOpen(true);
              setHasOpenedChat(true);
            }}
            className={`fixed bottom-8 right-8 z-30 w-14 h-14 rounded-full bg-clawde-ink text-clawde-parchment flex items-center justify-center shadow-xl hover:bg-clawde-ink/90 transition-all ${shouldPulseFab ? 'animate-fab-pulse' : ''}`}
            title="Ask about this document"
          >
            <MessageSquare className="w-6 h-6 text-clawde-parchment" />
          </button>

          {/* Slide-In Chat Drawer (Framer Motion) */}
          <AnimatePresence>
            {chatOpen && (
              <>
                {/* Backdrop */}
                <motion.div
                  className="fixed inset-0 bg-clawde-ink/40 z-40"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setChatOpen(false)}
                />

                {/* Right Drawer */}
                <motion.div
                  className="fixed right-0 top-0 bottom-0 w-full md:w-[60%] bg-clawde-offwhite border-l border-clawde-ink z-50 flex flex-col shadow-2xl"
                  initial={{ x: '100%' }}
                  animate={{ x: 0 }}
                  exit={{ x: '100%' }}
                  transition={{ duration: 0.25, ease: 'easeOut' }}
                >
                  <div className="flex items-center justify-between px-6 py-4 border-b border-clawde-ink/10 bg-clawde-offwhite shrink-0">
                    <div className="flex items-center gap-2">
                      <MessageSquare className="w-5 h-5 text-clawde-brass" />
                      <h2 className="font-serif font-bold text-lg text-clawde-ink">Ask About This Document</h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => setChatOpen(false)}
                      className="p-1.5 rounded text-clawde-ink/50 hover:text-clawde-oxblood hover:bg-clawde-ink/5 transition-colors"
                      title="Close panel (Escape)"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <ChatPanel
                      selectedDoc={selectedDoc}
                      apiUrl={API_URL}
                      hasSpeechRecognition={hasSpeechRecognition}
                      voiceLang={voiceLang}
                      onCycleLang={cycleLang}
                      isListening={isListening}
                      toggleListen={toggleListen}
                      voiceError={voiceError}
                      hasTTS={hasTTS}
                      speakingId={speakingId}
                      onSpeak={speak}
                      onStopSpeaking={stopSpeaking}
                    />
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

export default App;
