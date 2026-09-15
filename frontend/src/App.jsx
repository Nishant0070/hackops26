import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { FileText, Loader2, Calendar, Volume2, Square, Share2, AlertTriangle } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
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

  // Store page images for the Original tab
  const [pageImages, setPageImages] = useState([]);

  // Tabs
  const [centerTab, setCenterTab] = useState('extracted'); // 'original' | 'extracted'
  const [rightTab, setRightTab] = useState('summary'); // 'summary' | 'details' | 'timeline' | 'ask'

  const [isListening, setIsListening] = useState(false);
  const [voiceLang, setVoiceLang] = useState('en-IN'); // en-IN | hi-IN | mr-IN
  const [voiceError, setVoiceError] = useState(null);
  const recognitionRef = useRef(null);

  // TTS state — tracks which block is currently speaking (a unique id string)
  const [speakingId, setSpeakingId] = useState(null);
  const hasTTS = typeof window !== 'undefined' && 'speechSynthesis' in window;

  const [bnsMap, setBnsMap] = useState([]);
  // Detect speech support — Safari uses webkit prefix, Chrome uses standard
  const hasSpeechRecognition = typeof window !== 'undefined' && 
    ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window);

  useEffect(() => {
    fetchDocuments();
    fetchBnsMap();
  }, []);

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

  // Create the SpeechRecognition instance once on mount
  const initSpeechRecognition = () => {
    if (!hasSpeechRecognition) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = voiceLang;

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      // When voice input arrives, dispatch it as a custom event or handled via state
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

    let generatedImages = [];

    try {
      if (file.type === 'application/pdf') {
        // Render previews in browser for Original View
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
        const scale = 1.5;

        for (let i = 1; i <= Math.min(pdf.numPages, 10); i++) {
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          canvas.height = viewport.height;
          canvas.width = viewport.width;

          await page.render({ canvasContext: context, viewport }).promise;
          const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          generatedImages.push(dataUrl);
        }

        // Send raw PDF directly so backend digital-text layer detection can run
        formData.append('pages', file, file.name);
      } else {
        formData.append('pages', file);
        const objUrl = URL.createObjectURL(file);
        generatedImages.push(objUrl);
      }

      const response = await axios.post(`${API_URL}/upload`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          'X-Upload-ID': uploadId
        }
      });

      setSelectedDoc(response.data);
      setPageImages(generatedImages);
      setCenterTab('extracted');
      setRightTab('summary');
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
    setCenterTab('extracted');
    setRightTab('summary');
    setPageImages([]);
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

  // WhatsApp share helper for the summary tab
  const shareOnWhatsApp = (doc, lang = 'en') => {
    const bullets = lang === 'hi'
      ? (doc.structuredData?.summary_hi || []).join('\n• ')
      : (doc.structuredData?.summary_en || []).join('\n• ');
    const action = doc.structuredData?.action_required || '';
    const msg = `*Case Summary — Clawde Justice Assistant*\n\n${action ? `⚠️ ${action}\n\n` : ''}• ${bullets}\n\n_This summary was generated by Clawde (clawde.app). Always verify details with a qualified advocate._`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank', 'noopener');
  };

  const getBNSWarning = (citations) => {
    if (!citations || citations.length === 0) return null;
    const mapped = citations.map(c => bnsMap.find(m => m.old === c.citation || c.citation.includes(m.old))).filter(Boolean);
    if (mapped.length === 0) return null;

    return (
      <div className="bg-clawde-oxblood/10 border-l-4 border-clawde-oxblood p-4 my-4 rounded shadow-sm">
        <h4 className="text-clawde-oxblood font-bold flex items-center gap-2 mb-1 uppercase tracking-wider text-sm font-sans">
          <AlertTriangle className="w-4 h-4" /> Law Update Notice
        </h4>
        <div className="text-sm text-clawde-ink mt-2 font-sans">
          {mapped.map((m, i) => (
            <p key={i} className="mb-1">This document cites <strong>{m.old}</strong> ({m.offence}). Since 1 July 2024, the corresponding provision is <strong>{m.new}</strong>.</p>
          ))}
          <p className="text-xs text-clawde-ink mt-2 border-t border-clawde-oxblood/20 pt-2 font-serif italic">Which law applies depends on the date of the offence, not the date of the document. Offences before 1 July 2024 are still tried under the IPC.</p>
        </div>
      </div>
    );
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

  return (
    <div className="min-h-screen font-sans flex flex-col md:flex-row bg-clawde-ink text-clawde-charcoal overflow-hidden">
      
      {/* 1. LEFT PANEL (Case Browser) */}
      <div className="w-full md:w-3/12 lg:w-[22%] bg-clawde-ink border-r border-white/10 flex flex-col h-screen overflow-y-auto shrink-0 z-20">
        <div className="p-6 text-clawde-parchment">
          <h1 className="text-3xl font-bold font-serif flex items-center gap-2 tracking-tight">
            <FileText className="w-7 h-7 text-clawde-brass" /> Clawde
          </h1>
          <p className="text-xs text-clawde-parchment/60 mt-1 uppercase tracking-[0.2em] font-semibold">Justice Assistant</p>
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
              className={`w-full py-3 px-4 text-sm font-semibold transition-colors border ${uploading ? 'bg-clawde-ink border-white/20 text-white/50 cursor-wait' : 'bg-clawde-parchment text-clawde-ink border-clawde-parchment hover:bg-white'}`}
            >
              {uploading ? 'Processing Document...' : 'Upload New Document'}
            </button>
          </div>
        </div>

        <div className="flex-1 p-5 flex flex-col gap-3">
          <h3 className="text-[10px] font-bold text-clawde-parchment/50 uppercase tracking-widest mb-2 font-sans">Case Files</h3>
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
        <div className="flex-1 h-screen flex flex-col items-center justify-center bg-clawde-parchment text-clawde-ink/30 p-8 text-center">
          <FileText className="w-16 h-16 mb-4 opacity-50" />
          <p className="text-2xl font-serif">No document selected yet.</p>
          <p className="text-sm font-sans mt-2">Upload a scan or PDF to get started.</p>
        </div>
      ) : (
        <div className="flex-1 flex h-screen overflow-hidden">
          
          {/* 2. CENTER PANEL (Document Source) */}
          <div className="w-[55%] bg-clawde-parchment flex flex-col h-full border-r border-clawde-ink/10">
            {/* Tab Strip Center */}
            <div className="flex bg-clawde-offwhite border-b border-clawde-ink/10 pt-2 px-4 gap-1">
              <button 
                type="button"
                onClick={() => setCenterTab('original')}
                className={`px-6 py-3 text-sm font-semibold uppercase tracking-wider font-sans rounded-t ${centerTab === 'original' ? 'bg-clawde-parchment text-clawde-ink border-t-2 border-clawde-oxblood' : 'text-clawde-ink/60 hover:bg-clawde-parchment/50'}`}
              >
                Original
              </button>
              <button 
                type="button"
                onClick={() => setCenterTab('extracted')}
                className={`px-6 py-3 text-sm font-semibold uppercase tracking-wider font-sans rounded-t ${centerTab === 'extracted' ? 'bg-clawde-parchment text-clawde-ink border-t-2 border-clawde-oxblood' : 'text-clawde-ink/60 hover:bg-clawde-parchment/50'}`}
              >
                Extracted Text
              </button>
            </div>
            
            {/* Center Content */}
            <div className="flex-1 overflow-y-auto p-8 relative">
              {centerTab === 'original' && (
                <div className="flex flex-col gap-4 items-center">
                  {pageImages.length > 0 ? (
                    pageImages.map((imgUrl, idx) => (
                      <img key={idx} src={imgUrl} alt={`Page ${idx + 1}`} className="w-full max-w-2xl border border-clawde-ink/20 shadow-md" />
                    ))
                  ) : (
                    <p className="text-sm font-serif italic text-clawde-ink/50 text-center mt-20">Original scan view is preserved for newly uploaded documents in this session.</p>
                  )}
                </div>
              )}

              {centerTab === 'extracted' && (
                <div className="max-w-[75ch] mx-auto w-full">
                  {selectedDoc.structuredData?.uncertain_spans?.length > 0 && (
                    <div className="mb-6 flex items-center gap-2 text-[11px] uppercase tracking-wider font-semibold text-clawde-brass bg-clawde-brass/10 px-3 py-2 border-l-2 border-clawde-brass w-max">
                      <AlertTriangle className="w-3 h-3" /> OCR Uncertainties Highlighted
                    </div>
                  )}
                  <div 
                    className="font-serif text-[15px] leading-[1.8] text-clawde-charcoal whitespace-pre-wrap text-justify"
                    dangerouslySetInnerHTML={{ __html: highlightUncertainSpans(selectedDoc.structuredData?.raw_text, selectedDoc.structuredData?.uncertain_spans) }}
                  />
                </div>
              )}
            </div>
          </div>

          {/* 3. RIGHT PANEL (Analytical Lens) */}
          <div className="flex-1 bg-clawde-offwhite flex flex-col h-full">
            {/* Tab Strip Right */}
            <div className="flex bg-clawde-offwhite border-b border-clawde-ink/10 pt-2 px-2 overflow-x-auto no-scrollbar">
              {['summary', 'details', 'timeline', 'ask'].map(tab => (
                <button 
                  key={tab}
                  type="button"
                  onClick={() => setRightTab(tab)}
                  className={`px-5 py-3 text-sm font-semibold uppercase tracking-wider font-sans rounded-t whitespace-nowrap ${rightTab === tab ? 'bg-clawde-offwhite text-clawde-ink border-b-2 border-clawde-oxblood relative top-[1px]' : 'text-clawde-ink/50 hover:text-clawde-ink border-b-2 border-transparent'}`}
                >
                  {tab === 'ask' ? 'Ask (Chat)' : tab}
                </button>
              ))}
            </div>

            {/* Right Content */}
            <div className="flex-1 overflow-y-auto p-6 lg:p-8">
              
              {/* SUMMARY TAB */}
              {rightTab === 'summary' && (
                <div className="flex flex-col gap-8 h-full">
                  {selectedDoc.structuredData?.action_required && (
                    <div className="bg-clawde-oxblood text-white p-5 shadow-sm border-l-4 border-clawde-ink">
                      <h3 className="text-xs font-bold uppercase tracking-widest opacity-80 mb-1 font-sans">Action Required</h3>
                      <h2 className="text-lg font-bold font-serif leading-snug">
                        {selectedDoc.structuredData.action_required}
                      </h2>
                    </div>
                  )}
                  
                  <div className="flex flex-col gap-6">
                    <div className="bg-white p-6 border border-clawde-ink/10 relative">
                      <div className="absolute top-0 left-0 w-1 h-full bg-clawde-ink"></div>
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="font-bold text-clawde-ink/60 uppercase tracking-widest text-[10px] font-sans">English Summary</h3>
                        {hasTTS && (
                          <button
                            type="button"
                            onClick={() => speak((selectedDoc.structuredData?.summary_en || []).join('. '), 'en-IN', 'summary_en')}
                            className="p-1 text-clawde-ink/30 hover:text-clawde-ink transition-colors"
                            title={speakingId === 'summary_en' ? 'Stop' : 'Listen'}
                          >
                            {speakingId === 'summary_en' ? <Square className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </div>
                      <ul className="list-disc pl-5 space-y-3 font-serif text-clawde-charcoal text-[15px] leading-relaxed">
                        {selectedDoc.structuredData?.summary_en?.map((bullet, i) => (
                          <li key={i} className="pl-1">{bullet}</li>
                        ))}
                      </ul>
                    </div>
                    
                    <div className="bg-white p-6 border border-clawde-ink/10 relative">
                      <div className="absolute top-0 left-0 w-1 h-full bg-clawde-oxblood"></div>
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="font-bold text-clawde-ink/60 uppercase tracking-widest text-[10px] font-sans font-devanagari">इसका क्या मतलब है</h3>
                        {hasTTS && (
                          <button
                            type="button"
                            onClick={() => speak((selectedDoc.structuredData?.summary_hi || []).join('। '), 'hi-IN', 'summary_hi')}
                            className="p-1 text-clawde-ink/30 hover:text-clawde-oxblood transition-colors"
                            title={speakingId === 'summary_hi' ? 'Stop' : 'Listen'}
                          >
                            {speakingId === 'summary_hi' ? <Square className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </div>
                      <ul className="list-disc pl-5 space-y-3 font-devanagari text-clawde-charcoal text-[17px] leading-relaxed">
                        {selectedDoc.structuredData?.summary_hi?.map((bullet, i) => (
                          <li key={i} className="pl-1">{bullet}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  {getBNSWarning(selectedDoc.structuredData?.old_law_citations)}

                  {/* WhatsApp Share */}
                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => shareOnWhatsApp(selectedDoc, 'en')}
                      className="flex items-center gap-2 px-4 py-2 border border-clawde-ink/20 bg-white text-clawde-ink text-[12px] font-sans font-semibold uppercase tracking-wider hover:bg-[#25D366] hover:text-white hover:border-[#25D366] transition-colors"
                      title="Share English summary on WhatsApp"
                    >
                      <Share2 className="w-3.5 h-3.5" /> Share in English
                    </button>
                    <button
                      type="button"
                      onClick={() => shareOnWhatsApp(selectedDoc, 'hi')}
                      className="flex items-center gap-2 px-4 py-2 border border-clawde-ink/20 bg-white text-clawde-ink text-[12px] font-sans font-semibold uppercase tracking-wider hover:bg-[#25D366] hover:text-white hover:border-[#25D366] transition-colors"
                      title="Share Hindi summary on WhatsApp"
                    >
                      <Share2 className="w-3.5 h-3.5" /> हिंदी में शेयर करें
                    </button>
                  </div>
                </div>
              )}

              {/* DETAILS TAB */}
              {rightTab === 'details' && (
                <div className="flex flex-col gap-6">
                  <h2 className="text-2xl font-serif font-bold text-clawde-ink border-b border-clawde-ink/10 pb-4">Case Details</h2>
                  
                  <div className="grid grid-cols-1 gap-6">
                    <div>
                      <p className="text-[10px] font-bold text-clawde-ink/50 uppercase tracking-widest font-sans mb-1">Court Name</p>
                      <p className="text-base font-serif font-bold text-clawde-charcoal">{selectedDoc.structuredData?.court_name || "Unknown Court"}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-clawde-ink/50 uppercase tracking-widest font-sans mb-1">Case Number</p>
                      <p className="text-base font-serif text-clawde-charcoal">{selectedDoc.structuredData?.case_number || "N/A"}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-clawde-ink/50 uppercase tracking-widest font-sans mb-1">Document Type</p>
                      <p className="text-base font-serif text-clawde-charcoal">{selectedDoc.structuredData?.doc_type || "N/A"}</p>
                    </div>
                    
                    {selectedDoc.structuredData?.parties && selectedDoc.structuredData.parties.length > 0 && (
                      <div className="pt-4 border-t border-clawde-ink/10">
                        <p className="text-[10px] font-bold text-clawde-ink/50 uppercase tracking-widest font-sans mb-3">Parties Involved</p>
                        <div className="flex flex-col gap-3">
                          {selectedDoc.structuredData.parties.map((p, i) => (
                            <div key={i} className="flex flex-col bg-white p-3 border border-clawde-ink/10">
                              <span className="font-bold font-serif text-clawde-charcoal">{p.name}</span>
                              <span className="text-xs font-sans text-clawde-ink/60 uppercase tracking-wider">{p.role}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TIMELINE TAB */}
              {rightTab === 'timeline' && (
                <div className="flex flex-col gap-6 h-full">
                  <h2 className="text-2xl font-serif font-bold text-clawde-ink border-b border-clawde-ink/10 pb-4">Key Dates</h2>
                  
                  {!selectedDoc.structuredData?.key_dates || selectedDoc.structuredData.key_dates.length === 0 ? (
                    <p className="text-sm font-serif italic text-clawde-ink/50">No key dates extracted from this document.</p>
                  ) : (
                    <div className="flex flex-col relative pl-4 border-l border-clawde-ink/20 ml-2 mt-4 space-y-8">
                      {selectedDoc.structuredData.key_dates.map((kd, idx) => (
                        <div key={idx} className="relative pl-6">
                          <div className="absolute w-3 h-3 bg-clawde-oxblood rounded-full -left-[6.5px] top-1 border-2 border-clawde-offwhite"></div>
                          <div className="text-sm font-bold text-clawde-ink font-sans tracking-tight mb-1 flex items-center gap-2">
                            <Calendar className="w-4 h-4 text-clawde-ink/40" /> {kd.date}
                          </div>
                          <div className="text-base text-clawde-charcoal font-serif">{kd.event}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ASK TAB (Replaced with modular ChatPanel) */}
              {rightTab === 'ask' && (
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
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
