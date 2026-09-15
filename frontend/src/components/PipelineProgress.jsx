import React, { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle, Sparkles } from 'lucide-react';
import { TodoTool } from '@/components/agent-elements/todo-tool';
import { cn } from '@/lib/utils';

export function PipelineProgress({ uploadId, onComplete, onError, apiUrl }) {
  const [progress, setProgress] = useState({
    percent: 10,
    stage: 'initializing',
    message: 'Starting document intake...',
    timestamp: Date.now()
  });

  const [steps, setSteps] = useState([
    { id: 'intake', label: 'Document Intake & Verification', status: 'running' },
    { id: 'format', label: 'PDF Format & Text Layer Detection', status: 'pending' },
    { id: 'ocr', label: 'Text Extraction (Digital / OCR)', status: 'pending' },
    { id: 'structuring', label: 'Entity Extraction & Legal Structure (Groq)', status: 'pending' },
    { id: 'summary', label: 'Multilingual Summaries & Action Items', status: 'pending' }
  ]);

  useEffect(() => {
    if (!uploadId) return;

    const sseUrl = `${apiUrl}/progress/${uploadId}`;
    const eventSource = new EventSource(sseUrl);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setProgress({
          percent: data.percent || 10,
          stage: data.stage || 'processing',
          message: data.message || 'Processing document...',
          timestamp: data.timestamp || Date.now()
        });

        // Update step states based on stage
        setSteps(prevSteps => {
          return prevSteps.map(step => {
            if (data.stage === 'upload_received') {
              if (step.id === 'intake') return { ...step, status: 'completed' };
              if (step.id === 'format') return { ...step, status: 'running' };
            }
            if (data.stage === 'pdf_analysis' || data.stage === 'format_detection') {
              if (step.id === 'intake') return { ...step, status: 'completed' };
              if (step.id === 'format') return { ...step, status: 'running' };
            }
            if (data.stage === 'ocr_extraction' || data.stage === 'pdf_text_extracted') {
              if (step.id === 'intake' || step.id === 'format') return { ...step, status: 'completed' };
              if (step.id === 'ocr') return { ...step, status: 'running' };
            }
            if (data.stage === 'structuring') {
              if (step.id === 'intake' || step.id === 'format' || step.id === 'ocr') return { ...step, status: 'completed' };
              if (step.id === 'structuring') return { ...step, status: 'running' };
            }
            if (data.stage === 'summarizing') {
              if (step.id !== 'summary') return { ...step, status: 'completed' };
              if (step.id === 'summary') return { ...step, status: 'running' };
            }
            if (data.stage === 'completed') {
              return { ...step, status: 'completed' };
            }
            return step;
          });
        });

        if (data.stage === 'completed') {
          eventSource.close();
          if (onComplete) onComplete(data.detail);
        } else if (data.stage === 'error') {
          eventSource.close();
          if (onError) onError(data.message);
        }
      } catch (err) {
        console.warn('Failed to parse SSE progress event:', err);
      }
    };

    eventSource.onerror = () => {
      // Keep running unless explicitly errored out
      console.log('SSE connection waiting...');
    };

    return () => {
      eventSource.close();
    };
  }, [uploadId, apiUrl, onComplete, onError]);

  const isComplete = progress.stage === 'completed';
  const isError = progress.stage === 'error';

  return (
    <div className="flex flex-col gap-4 p-6 bg-[var(--color-clawde-parchment)] border border-[#E2D9CC] rounded-xl shadow-md max-w-lg w-full">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isError ? (
            <AlertCircle className="w-5 h-5 text-[var(--color-clawde-oxblood)]" />
          ) : isComplete ? (
            <CheckCircle2 className="w-5 h-5 text-green-700" />
          ) : (
            <Loader2 className="w-5 h-5 text-[var(--color-clawde-brass)] animate-spin" />
          )}
          <h3 className="font-serif font-bold text-base text-[var(--color-clawde-ink)]">
            {isError ? 'Processing Issue' : isComplete ? 'Docket Digitized' : 'Digitizing Document'}
          </h3>
        </div>
        <span className="text-xs font-semibold text-[var(--color-clawde-charcoal)]/80 font-mono">
          {progress.percent}%
        </span>
      </div>

      {/* Progress Track */}
      <div className="w-full bg-[#E2D9CC] h-2 rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full transition-all duration-300 ease-out",
            isError ? "bg-[var(--color-clawde-oxblood)]" : "bg-[var(--color-clawde-ink)]"
          )}
          style={{ width: `${progress.percent}%` }}
        />
      </div>

      <p className="text-xs text-[var(--color-clawde-charcoal)] font-sans italic">
        {progress.message}
      </p>

      {/* Step Breakdown */}
      <TodoTool items={steps} title="Intake Pipeline" className="bg-white/80" />
    </div>
  );
}
