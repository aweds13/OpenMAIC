'use client';

import { emitQuizReviewed } from '@/lib/classroom/quiz-reviewed';
import { memo, useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { answerIncludesOption } from '@/lib/quiz/grading';
import {
  PieChart,
  CheckCircle2,
  XCircle,
  RotateCcw,
  ChevronRight,
  Check,
  BookOpenText,
  Loader2,
  Sparkles,
  HelpCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';

const log = createLogger('QuizView');
import type { QuizQuestion } from '@/lib/types/stage';
import { SpeechButton } from '@/components/audio/speech-button';
import { gradeChoiceQuestions, isShortAnswer, type QuestionResult } from '@/lib/quiz/grading';
import {
  CONFIDENCE_LEVELS,
  answeredQuestionIds,
  calibrationFromResults,
  confidenceOf,
  isConfidenceComplete,
  withConfidence,
  type ConfidenceLevel,
  type ConfidenceMap,
} from '@/lib/quiz/confidence';
import { renderQuizMathText } from '@/lib/quiz/math-text';
import { writeDraftRecovery } from '@/lib/quiz/persistence';
import {
  createQuizAttemptWriter,
  loadQuizAttemptState,
  QuizRetryProgressedError,
  type QuizAttemptWriter,
} from '@/lib/quiz/runtime';
import {
  createQuizViewLifetime,
  isQuizRuntimeReady,
  persistQuizReview,
  persistQuizRetry,
  persistQuizSubmission,
  quizViewStateFromAttempt,
  runQuizPersistenceTransition,
  type QuizRuntimeGate,
  type QuizViewLifetime,
} from '@/lib/quiz/view-state';
import { recordAnswerAttempt, recordAnswerSubmitted } from '@/lib/learning/xq-answer-events';
import { useQuizAsk } from '@/lib/contexts/quiz-ask-context';

// ─── Types ──────────────────────────────────────────────────────────────────

type Phase = 'not_started' | 'answering' | 'submitting' | 'grading' | 'reviewing';

interface QuizViewProps {
  readonly questions: QuizQuestion[];
  readonly sceneId: string;
  readonly stageId: string;
}

const QuizMathText = memo(function QuizMathText({
  text,
  className,
  allowDisplayMode = false,
}: {
  text: string;
  className?: string;
  allowDisplayMode?: boolean;
}) {
  const segments = useMemo(() => renderQuizMathText(text), [text]);
  if (segments.length === 1 && segments[0].type === 'text') {
    return <span className={className}>{segments[0].value}</span>;
  }

  return (
    <span className={className}>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return <span key={index}>{segment.value}</span>;
        }

        return (
          <span
            key={index}
            className={cn(
              allowDisplayMode && segment.displayMode
                ? 'block my-1 overflow-x-auto [&_.katex-display]:!my-0'
                : 'inline-block align-baseline [&_.katex-display]:!my-0',
            )}
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        );
      })}
    </span>
  );
});

/** Call /api/quiz-grade for a single short-answer question. */
async function gradeShortAnswerQuestion(
  q: QuizQuestion,
  userAnswer: string,
  language: string,
): Promise<QuestionResult> {
  const pts = q.points ?? 1;
  try {
    // The server grades with the workspace's classroom model.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const res = await fetch('/api/quiz-grade', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        question: q.question,
        userAnswer,
        points: pts,
        commentPrompt: q.commentPrompt,
        language,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { score: number; comment: string };
    const earned = Math.max(0, Math.min(pts, data.score));
    return {
      questionId: q.id,
      correct: earned >= pts * 0.8,
      status: earned >= pts * 0.8 ? 'correct' : 'incorrect',
      earned,
      aiComment: data.comment,
    };
  } catch (err) {
    log.error('[quiz-view] AI grading failed for', q.id, err);
    // Fallback: give half credit
    return {
      questionId: q.id,
      correct: null,
      status: 'incorrect',
      earned: Math.round(pts * 0.5),
      aiComment:
        language === 'zh-CN'
          ? '评分服务暂时不可用，已给予基础分。'
          : 'Grading service unavailable. Base score given.',
    };
  }
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function QuizCover({
  questionCount,
  totalPoints,
  onStart,
}: {
  questionCount: number;
  totalPoints: number;
  onStart: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-4 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 right-0 p-6 opacity-[0.03]">
        <PieChart className="w-52 h-52 text-violet-500" />
      </div>
      <div className="absolute bottom-0 left-0 p-6 opacity-[0.02]">
        <BookOpenText className="w-40 h-40 text-violet-500 rotate-12" />
      </div>

      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        className="w-16 h-16 bg-gradient-to-br from-violet-100 to-purple-50 dark:from-violet-900/50 dark:to-purple-900/30 rounded-2xl flex items-center justify-center shadow-lg shadow-violet-100 dark:shadow-violet-900/30 ring-1 ring-violet-200/50 dark:ring-violet-700/50"
      >
        <PieChart className="w-8 h-8 text-violet-500" />
      </motion.div>

      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1 }}
        className="text-center z-10"
      >
        <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100">{t('quiz.title')}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('quiz.subtitle')}</p>
      </motion.div>

      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="flex gap-5 text-sm z-10"
      >
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <div className="w-7 h-7 rounded-lg bg-violet-50 dark:bg-violet-900/30 flex items-center justify-center">
            <BookOpenText className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <span>
            {questionCount} {t('quiz.questionsCount')}
          </span>
        </div>
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <div className="w-7 h-7 rounded-lg bg-violet-50 dark:bg-violet-900/30 flex items-center justify-center">
            <PieChart className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <span>
            {t('quiz.totalPrefix')} {totalPoints} {t('quiz.pointsSuffix')}
          </span>
        </div>
      </motion.div>

      <motion.button
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3 }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={onStart}
        className="mt-1 px-8 py-2.5 bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded-full font-medium shadow-lg shadow-violet-200/50 dark:shadow-violet-900/50 hover:shadow-violet-300/50 transition-shadow z-10 flex items-center gap-2"
      >
        {t('quiz.startQuiz')}
        <ChevronRight className="w-4 h-4" />
      </motion.button>
    </div>
  );
}

function SingleChoiceQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
  confidence,
  onConfidence,
}: {
  question: QuizQuestion;
  index: number;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  result?: QuestionResult;
  confidence?: ConfidenceLevel;
  onConfidence?: (level: ConfidenceLevel) => void;
}) {
  const isReview = !!result;

  return (
    <QuestionCard
      question={question}
      index={index}
      result={result}
      confidence={confidence}
      onConfidence={onConfidence}
    >
      <div className="grid gap-2">
        {question.options?.map((opt) => {
          const selected = value === opt.value;
          const isCorrectOpt = isReview && answerIncludesOption(question, opt.value);
          const isWrong = isReview && selected && result?.status === 'incorrect';

          return (
            <button
              key={opt.value}
              disabled={disabled}
              onClick={() => !disabled && onChange(opt.value)}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all text-sm',
                // Default state
                !isReview &&
                  !selected &&
                  'border-gray-200 dark:border-gray-600 hover:border-violet-200 dark:hover:border-violet-700 hover:bg-violet-50/50 dark:hover:bg-violet-900/30',
                !isReview &&
                  selected &&
                  'border-violet-400 bg-violet-50 dark:bg-violet-900/30 ring-1 ring-violet-200 dark:ring-violet-700',
                // Review states
                isReview &&
                  isCorrectOpt &&
                  'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30',
                isReview &&
                  isWrong &&
                  !isCorrectOpt &&
                  'border-red-300 bg-red-50 dark:bg-red-900/30',
                isReview &&
                  !isCorrectOpt &&
                  !selected &&
                  'border-gray-100 dark:border-gray-700 opacity-60',
                disabled && !isReview && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-colors',
                  !isReview &&
                    !selected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
                  !isReview && selected && 'bg-violet-500 text-white',
                  isReview && isCorrectOpt && 'bg-emerald-500 text-white',
                  isReview && isWrong && !isCorrectOpt && 'bg-red-400 text-white',
                  isReview &&
                    !isCorrectOpt &&
                    !selected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500',
                )}
              >
                {opt.value}
              </span>
              <span
                className={cn(
                  'flex-1',
                  isReview && !isCorrectOpt && !selected && 'text-gray-400 dark:text-gray-500',
                )}
              >
                <QuizMathText text={opt.label} />
              </span>
              {isReview && isCorrectOpt && (
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
              )}
              {isReview && isWrong && !isCorrectOpt && (
                <XCircle className="w-5 h-5 text-red-400 shrink-0" />
              )}
            </button>
          );
        })}
      </div>
    </QuestionCard>
  );
}

function MultipleChoiceQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
  confidence,
  onConfidence,
}: {
  question: QuizQuestion;
  index: number;
  value?: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  result?: QuestionResult;
  confidence?: ConfidenceLevel;
  onConfidence?: (level: ConfidenceLevel) => void;
}) {
  const isReview = !!result;
  const selected = value ?? [];

  const toggle = (optValue: string) => {
    if (disabled) return;
    if (selected.includes(optValue)) {
      onChange(selected.filter((v) => v !== optValue));
    } else {
      onChange([...selected, optValue]);
    }
  };

  const { t } = useI18n();

  return (
    <QuestionCard
      question={question}
      index={index}
      result={result}
      confidence={confidence}
      onConfidence={onConfidence}
    >
      {!isReview && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">
          {t('quiz.multipleChoiceHint')}
        </p>
      )}
      <div className="grid gap-2">
        {question.options?.map((opt) => {
          const isSelected = selected.includes(opt.value);
          const isCorrectOpt = isReview && answerIncludesOption(question, opt.value);
          const isWrong = isReview && isSelected && !isCorrectOpt;

          return (
            <button
              key={opt.value}
              disabled={disabled}
              onClick={() => toggle(opt.value)}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all text-sm',
                !isReview &&
                  !isSelected &&
                  'border-gray-200 dark:border-gray-600 hover:border-violet-200 dark:hover:border-violet-700 hover:bg-violet-50/50 dark:hover:bg-violet-900/30',
                !isReview &&
                  isSelected &&
                  'border-violet-400 bg-violet-50 dark:bg-violet-900/30 ring-1 ring-violet-200 dark:ring-violet-700',
                isReview &&
                  isCorrectOpt &&
                  'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30',
                isReview && isWrong && 'border-red-300 bg-red-50 dark:bg-red-900/30',
                isReview &&
                  !isCorrectOpt &&
                  !isSelected &&
                  'border-gray-100 dark:border-gray-700 opacity-60',
                disabled && !isReview && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 transition-colors',
                  !isReview &&
                    !isSelected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
                  !isReview && isSelected && 'bg-violet-500 text-white',
                  isReview && isCorrectOpt && 'bg-emerald-500 text-white',
                  isReview && isWrong && 'bg-red-400 text-white',
                  isReview &&
                    !isCorrectOpt &&
                    !isSelected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500',
                )}
              >
                {!isReview && isSelected ? <Check className="w-3.5 h-3.5" /> : opt.value}
              </span>
              <span
                className={cn(
                  'flex-1',
                  isReview && !isCorrectOpt && !isSelected && 'text-gray-400 dark:text-gray-500',
                )}
              >
                <QuizMathText text={opt.label} />
              </span>
              {isReview && isCorrectOpt && (
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
              )}
              {isReview && isWrong && <XCircle className="w-5 h-5 text-red-400 shrink-0" />}
            </button>
          );
        })}
      </div>
    </QuestionCard>
  );
}

function ShortAnswerQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
  confidence,
  onConfidence,
}: {
  question: QuizQuestion;
  index: number;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  result?: QuestionResult;
  confidence?: ConfidenceLevel;
  onConfidence?: (level: ConfidenceLevel) => void;
}) {
  const isReview = !!result;
  const { t } = useI18n();
  // Ref to track latest value for voice transcription append
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  return (
    <QuestionCard
      question={question}
      index={index}
      result={result}
      confidence={confidence}
      onConfidence={onConfidence}
    >
      {!isReview ? (
        <div className="relative">
          <textarea
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={t('quiz.inputPlaceholder')}
            className="w-full min-h-[100px] p-3 pb-10 rounded-xl border border-gray-200 dark:border-gray-600 text-sm resize-none focus:outline-none focus:border-violet-300 dark:focus:border-violet-600 focus:ring-2 focus:ring-violet-100 dark:focus:ring-violet-900/50 transition-all disabled:bg-gray-50 dark:disabled:bg-gray-800 disabled:text-gray-500 dark:bg-gray-800/50 dark:text-gray-200 dark:placeholder:text-gray-500"
          />
          <SpeechButton
            size="sm"
            disabled={disabled}
            className="absolute bottom-3 left-3"
            onTranscription={(text) => {
              const cur = valueRef.current ?? '';
              onChange(cur + (cur ? ' ' : '') + text);
            }}
          />
          <span className="absolute bottom-3 right-3 text-xs text-gray-300 dark:text-gray-600">
            {(value ?? '').length} {t('quiz.charCount')}
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-300">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{t('quiz.yourAnswer')}</p>
            {value ? (
              <QuizMathText text={value} />
            ) : (
              <span className="text-gray-400 dark:text-gray-500 italic">
                {t('quiz.notAnswered')}
              </span>
            )}
          </div>
          {result.aiComment && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-violet-50 dark:bg-violet-900/30 border border-violet-100 dark:border-violet-800">
              <Sparkles className="w-4 h-4 text-violet-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-violet-600 dark:text-violet-400 mb-0.5">
                  {t('quiz.aiComment')}
                </p>
                <p className="text-xs text-violet-600/80 dark:text-violet-400/80">
                  <QuizMathText text={result.aiComment} />
                </p>
              </div>
              <span className="ml-auto text-xs font-bold text-violet-600 dark:text-violet-400 shrink-0">
                {result.earned}/{question.points ?? 1}
                {t('quiz.pointsSuffix')}
              </span>
            </div>
          )}
        </div>
      )}
    </QuestionCard>
  );
}

function QuestionCard({
  question,
  index,
  result,
  confidence,
  onConfidence,
  children,
}: {
  question: QuizQuestion;
  index: number;
  result?: QuestionResult;
  /** 这一题他已经选过的把握。没选过就是 `undefined`。 */
  confidence?: ConfidenceLevel;
  /** 给了才显示自评行 —— 复习态、以及没有写入方的地方不显示。 */
  onConfidence?: (level: ConfidenceLevel) => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const isReview = !!result;
  const pts = question.points ?? 1;
  const ask = useQuizAsk();
  /**
   * 展开的两种问法。`null` = 收着。
   *
   * 为什么是「先展开再选」而不是两个常驻按钮：常驻两个按钮会让每一道题
   * 都多出两个凸起的控件，而绝大多数题目学生是不想问的。展开这一步也是
   * 一次极短的停顿 —— 正好卡在「他想问」与「他真的问了」之间。
   */
  const [askOpen, setAskOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [askNotice, setAskNotice] = useState<string>('');

  const handleAsk = useCallback(
    async (subtype: 'instrumental' | 'executive') => {
      if (!ask || asking) return;
      setAsking(true);
      setAskNotice('');
      try {
        const outcome = await ask.ask(
          { questionId: question.id, stem: question.question },
          subtype,
        );
        // 三种结果说三句不同的话。★ `refused` 不是错误：那是闸按设计工作，
        // 这时该说「先写下你的想法」，而不是「失败了，再试一次」——
        // 后者会把学生推回去再点一次，而再点一次仍然是 409。
        if (outcome.status === 'refused') setAskNotice(t('quiz.ask.refused'));
        else if (outcome.status === 'failed') setAskNotice(t('quiz.ask.failed'));
        else if (outcome.status === 'unsent') setAskNotice(t('quiz.ask.unsent'));
        else {
          setAskOpen(false);
          setAskNotice('');
        }
      } finally {
        setAsking(false);
      }
    },
    [ask, asking, question.id, question.question, t],
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      className={cn(
        'bg-white dark:bg-gray-800 rounded-2xl border p-5 relative overflow-hidden',
        !isReview && 'border-gray-150 dark:border-gray-700 shadow-sm',
        isReview &&
          result.status === 'correct' &&
          'border-emerald-200 dark:border-emerald-800 shadow-sm shadow-emerald-50 dark:shadow-emerald-900/20',
        isReview &&
          result.status === 'incorrect' &&
          'border-red-200 dark:border-red-800 shadow-sm shadow-red-50 dark:shadow-red-900/20',
      )}
    >
      {/* Left accent */}
      <div
        className={cn(
          'absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl',
          !isReview && 'bg-violet-400',
          isReview && result.status === 'correct' && 'bg-emerald-400',
          isReview && result.status === 'incorrect' && 'bg-red-400',
        )}
      />

      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0',
              !isReview &&
                'bg-violet-100 dark:bg-violet-900/50 text-violet-600 dark:text-violet-400',
              isReview &&
                result.status === 'correct' &&
                'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400',
              isReview &&
                result.status === 'incorrect' &&
                'bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400',
            )}
          >
            {index + 1}
          </span>
          <div>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100 leading-relaxed">
              <QuizMathText text={question.question} allowDisplayMode />
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              {question.type === 'single'
                ? t('quiz.singleChoice')
                : question.type === 'multiple'
                  ? t('quiz.multipleChoice')
                  : t('quiz.shortAnswer')}
              {' · '}
              {pts} {t('quiz.pointsSuffix')}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 ml-2">
          {/* 问 AI。没有聊天框时（编辑态 / 预览 / 单测）`ask` 是 null，
              整个按钮不渲染 —— 不做一个点了没反应的按钮。 */}
          {ask !== null && (
            <button
              type="button"
              data-testid="quiz-ask-toggle"
              aria-expanded={askOpen}
              onClick={() => {
                setAskOpen((open) => !open);
                setAskNotice('');
              }}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-400 transition-colors hover:bg-violet-50 hover:text-violet-600 dark:hover:bg-violet-900/30 dark:hover:text-violet-400"
            >
              <HelpCircle className="h-3.5 w-3.5" />
              {t('quiz.ask.label')}
            </button>
          )}
          {isReview && (
            <div>
              {result.status === 'correct' && <CheckCircle2 className="w-6 h-6 text-emerald-500" />}
              {result.status === 'incorrect' && <XCircle className="w-6 h-6 text-red-400" />}
            </div>
          )}
        </div>
      </div>

      {/* 两种问法。★ 分成两个按钮而不是一个：`instrumental`（问「怎么想」）
          与 `executive`（直接要答案）与成绩的相关方向相反，让界面记两个
          不同的值，比事后从文本反推可靠。 */}
      {ask !== null && askOpen && (
        <div className="mb-3 rounded-lg border border-violet-100 bg-violet-50/60 p-3 dark:border-violet-800 dark:bg-violet-900/20">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="quiz-ask-instrumental"
              disabled={asking}
              onClick={() => void handleAsk('instrumental')}
              className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-violet-700 shadow-sm transition-colors hover:bg-violet-100 disabled:opacity-50 dark:bg-violet-900/40 dark:text-violet-200 dark:hover:bg-violet-900/60"
            >
              {t('quiz.ask.instrumental')}
            </button>
            <button
              type="button"
              data-testid="quiz-ask-executive"
              disabled={asking}
              onClick={() => void handleAsk('executive')}
              className="rounded-lg bg-white px-3 py-1.5 text-xs text-gray-500 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
            >
              {t('quiz.ask.executive')}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-violet-500/80 dark:text-violet-300/70">
            {t('quiz.ask.hint')}
          </p>
        </div>
      )}

      {askNotice !== '' && (
        <p
          data-testid="quiz-ask-notice"
          className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
        >
          {askNotice}
        </p>
      )}

      {/* 自评。★ 位置在题干与选项**之下**：他得先看过这道题才有资格说
          「我有多大把握」，而四档里最低那档写的是「基本靠猜」——
          没读题就点它只是在回避。复习态不显示：那时他已知对错，
          再问「当时有多大把握」得到的不是预测，是回忆。 */}
      {onConfidence !== undefined && (
        <div data-testid="quiz-confidence" className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-gray-400 dark:text-gray-500">
            {t('quiz.confidence.label')}
          </span>
          {CONFIDENCE_LEVELS.map((level) => {
            const active = confidence === level;
            return (
              <button
                key={level}
                type="button"
                data-testid={`quiz-confidence-${level}`}
                aria-pressed={active}
                onClick={() => onConfidence(level)}
                className={cn(
                  'rounded-full px-2.5 py-0.5 text-[11px] transition-colors',
                  active
                    ? 'bg-violet-500 text-white'
                    : 'bg-gray-100 text-gray-500 hover:bg-violet-50 hover:text-violet-600 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-violet-900/40',
                )}
              >
                {t(`quiz.confidence.level${level}` as never)}
              </button>
            );
          })}
        </div>
      )}

      {/* Body */}
      {children}

      {/* Analysis (review only) */}
      {isReview && question.analysis && (
        <div className="mt-3 p-3 rounded-lg bg-blue-50/70 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800 text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
          <span className="font-medium">{t('quiz.analysis')}</span>
          <QuizMathText text={question.analysis} allowDisplayMode />
        </div>
      )}
    </motion.div>
  );
}

/**
 * 校准条：他说的把握与真实正确率差多少。
 *
 * ★ 只在题数够的时候给标签（`CONFIDENCE_LABEL_MIN_COUNT = 8`），不够时
 * 说的是「还差几道题」而不是「你的判断很准」。后者是一句它并不知道的话。
 * ★ 这一条**永远不进掌握度**：它描述的是「他知不知道自己会」，不是
 * 「他会不会」。二者零相关（Karpicke & Roediger 2008）。
 */
function CalibrationBanner({
  results,
  confidence,
}: {
  results: QuestionResult[];
  confidence: ConfidenceMap;
}) {
  const { t } = useI18n();
  const calibration = useMemo(
    () => calibrationFromResults(confidence, results),
    [confidence, results],
  );
  if (calibration.count === 0) return null;
  const tone =
    calibration.label === 'over'
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
      : calibration.label === 'under'
        ? 'bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300'
        : 'bg-gray-50 text-gray-600 dark:bg-gray-800/60 dark:text-gray-300';
  return (
    <div
      data-testid="quiz-calibration"
      data-label={calibration.label ?? 'unknown'}
      className={cn('rounded-xl px-4 py-3 text-xs leading-relaxed', tone)}
    >
      <span className="font-medium">{t('quiz.confidence.title')}</span>{' '}
      {t('quiz.confidence.summary', {
        expected: Math.round(calibration.expected),
        actual: Math.round(calibration.actual),
        count: calibration.count,
      })}
      {' — '}
      {calibration.label === undefined
        ? t('quiz.confidence.needMore', { needed: calibration.needed })
        : t(`quiz.confidence.calibration.${calibration.label}` as never)}
    </div>
  );
}

function ScoreBanner({
  score,
  total,
  results,
}: {
  score: number;
  total: number;
  results: QuestionResult[];
}) {
  const { t } = useI18n();
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const correctCount = results.filter((r) => r.status === 'correct').length;
  const incorrectCount = results.filter((r) => r.status === 'incorrect').length;

  const color = pct >= 80 ? 'emerald' : pct >= 60 ? 'amber' : 'red';
  const colorMap = {
    emerald: {
      bg: 'from-emerald-500 to-teal-500',
      shadow: 'shadow-emerald-200/50 dark:shadow-emerald-900/50',
      ring: 'bg-emerald-400/30',
      text: t('quiz.excellent'),
    },
    amber: {
      bg: 'from-amber-500 to-yellow-500',
      shadow: 'shadow-amber-200/50 dark:shadow-amber-900/50',
      ring: 'bg-amber-400/30',
      text: t('quiz.keepGoing'),
    },
    red: {
      bg: 'from-red-500 to-rose-500',
      shadow: 'shadow-red-200/50 dark:shadow-red-900/50',
      ring: 'bg-red-400/30',
      text: t('quiz.needsReview'),
    },
  };
  const c = colorMap[color];

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className={cn('rounded-2xl p-6 bg-gradient-to-r text-white shadow-lg', c.bg, c.shadow)}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-white/80 text-sm font-medium">{c.text}</p>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-4xl font-black">{score}</span>
            <span className="text-white/60 text-lg">/ {total}</span>
          </div>
          <div className="flex gap-3 mt-3 text-xs">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> {correctCount} {t('quiz.correct')}
            </span>
            <span className="flex items-center gap-1">
              <XCircle className="w-3.5 h-3.5" /> {incorrectCount} {t('quiz.incorrect')}
            </span>
          </div>
        </div>

        {/* Percentage ring */}
        <div className="relative w-20 h-20">
          <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
            <circle
              cx="40"
              cy="40"
              r="34"
              fill="none"
              stroke="rgba(255,255,255,0.2)"
              strokeWidth="6"
            />
            <motion.circle
              cx="40"
              cy="40"
              r="34"
              fill="none"
              stroke="white"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 34}`}
              initial={{ strokeDashoffset: 2 * Math.PI * 34 }}
              animate={{ strokeDashoffset: 2 * Math.PI * 34 * (1 - pct / 100) }}
              transition={{ duration: 1, ease: 'easeOut', delay: 0.3 }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-lg font-black">{pct}%</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function QuizView({ questions, sceneId, stageId }: QuizViewProps) {
  const { t, locale } = useI18n();

  const [phase, setPhase] = useState<Phase>('not_started');
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [confidence, setConfidence] = useState<ConfidenceMap>({});
  const [results, setResults] = useState<QuestionResult[]>([]);
  const [runtimeGate, setRuntimeGate] = useState<QuizRuntimeGate>({ status: 'loading' });
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const viewLifetimeRef = useRef<QuizViewLifetime | null>(null);
  viewLifetimeRef.current ??= createQuizViewLifetime();
  const viewLifetime = viewLifetimeRef.current;
  /**
   * 已经记过 `answer_attempted` 的题目。幂等键在服务端也兜得住，
   * 但每敲一个字发一个请求没有意义 —— 这件事的语义是「他动过手」，
   * 第一次动就够了。换 attempt（重做）时随 `hydrationVersion` 一起清。
   */
  const attemptRecordedRef = useRef<Set<string>>(new Set());
  const runtimeWriterRef = useRef<QuizAttemptWriter | null>(null);
  runtimeWriterRef.current ??= createQuizAttemptWriter({
    onError: (error) => log.warn('Failed to persist quiz runtime:', error),
  });
  const runtimeWriter = runtimeWriterRef.current;

  useEffect(() => {
    return () => {
      void runtimeWriter.flushDraft();
    };
  }, [runtimeWriter]);

  useEffect(() => {
    let cancelled = false;
    setRuntimeGate({ status: 'loading' });
    setRetrying(false);
    // 换了一轮作答（首次载入 / 重做 / 另一个页签推进了）：上一轮的
    // 「记过没记过」不再适用，否则重做后的第一次输入会被旧集合吃掉。
    attemptRecordedRef.current = new Set();
    void loadQuizAttemptState({ stageId, sceneId })
      .then(({ attemptId: nextAttemptId, state }) => {
        if (cancelled) return;
        const next = quizViewStateFromAttempt(state);
        setPhase(next.phase);
        setAnswers(next.answers);
        setConfidence(next.confidence);
        setResults(next.results);
        setRuntimeGate({ status: 'ready', attemptId: nextAttemptId });
      })
      .catch((error) => {
        log.warn('Failed to hydrate quiz runtime:', error);
        if (!cancelled) setRuntimeGate({ status: 'error' });
      });
    return () => {
      cancelled = true;
      viewLifetime.invalidate();
      void runtimeWriter.flushDraft();
    };
  }, [hydrationVersion, runtimeWriter, sceneId, stageId, viewLifetime]);

  const attemptId = isQuizRuntimeReady(runtimeGate) ? runtimeGate.attemptId : null;

  const totalPoints = useMemo(
    () => questions.reduce((sum, q) => sum + (q.points ?? 1), 0),
    [questions],
  );

  const allAnswered = useMemo(() => {
    return questions.every((q) => {
      const a = answers[q.id];
      if (!a) return false;
      if (Array.isArray(a)) return a.length > 0;
      return (a as string).trim().length > 0;
    });
  }, [questions, answers]);

  /**
   * 自评问全了没有。★ 只对**答过**的题要求自评：没作答的题它不问，
   * 因为一道他跳过的题不存在「有多大把握」这种判断 —— 强行要一个
   * 会让「跳过」变成一次必填，而那与 desirable difficulty 相反。
   */
  const confidenceComplete = useMemo(
    () =>
      isConfidenceComplete(
        answeredQuestionIds(
          questions.map((q) => q.id),
          answers,
        ),
        confidence,
      ),
    [questions, answers, confidence],
  );

  const canSubmit = allAnswered && confidenceComplete;

  const handleSetAnswer = useCallback(
    (questionId: string, value: string | string[]) => {
      setAnswers((prev) => {
        const next = { ...prev, [questionId]: value };
        // 「他动过手」要在**提交之前**就能落库 —— 只写了一半就卡住的人，
        // 恰恰是最该允许提问的那类，而探针表那时候一行都还没有。
        const nonEmpty = Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
        if (nonEmpty && !attemptRecordedRef.current.has(questionId)) {
          attemptRecordedRef.current.add(questionId);
          recordAnswerAttempt(
            { stageId, sceneId, attemptId: attemptId ?? '' },
            questionId,
            Array.isArray(value) ? value.join('').length : value.length,
          );
        }
        if (attemptId) {
          writeDraftRecovery(sceneId, attemptId, next);
          runtimeWriter.scheduleDraft({
            stageId,
            sceneId,
            attemptId,
            answers: next,
          });
        }
        return next;
      });
    },
    [attemptId, runtimeWriter, sceneId, stageId],
  );

  /**
   * 记一道题的自评，并顺手把草稿写下去。
   *
   * 为什么自评也要走 `scheduleDraft`：刷新页面时 `loadQuizAttemptState` 读的是
   * 库里的最后一条 payload。只存在组件 state 里的话，他刷新一次就得重填
   * 一遍把握 —— 而那时候答案还在、只有把握没了，看起来像被吞了。
   */
  const handleSetConfidence = useCallback(
    (questionId: string, level: ConfidenceLevel) => {
      setConfidence((prev) => {
        const next = withConfidence(prev, questionId, level);
        if (attemptId) {
          runtimeWriter.scheduleDraft({ stageId, sceneId, attemptId, answers, confidence: next });
        }
        return next;
      });
    },
    [answers, attemptId, runtimeWriter, sceneId, stageId],
  );

  const handleSubmit = useCallback(async () => {
    if (!attemptId) return;
    setPhase('submitting');
    await runQuizPersistenceTransition(
      () =>
        persistQuizSubmission({ stageId, sceneId, attemptId, answers, confidence }, runtimeWriter),
      viewLifetime,
      () => setPhase('grading'),
      (error) => {
        log.warn('Failed to persist quiz submission:', error);
        setRuntimeGate({ status: 'error' });
      },
    );
  }, [attemptId, answers, confidence, runtimeWriter, sceneId, stageId, viewLifetime]);

  // When entering grading phase, grade choice questions locally + call API for short-answer
  useEffect(() => {
    if (phase !== 'grading') return;
    let cancelled = false;

    (async () => {
      // 1. Grade choice questions locally (instant)
      const choiceResults = gradeChoiceQuestions(questions, answers);

      // 2. Grade short-answer questions via AI API (parallel)
      const shortAnswerQs = questions.filter(isShortAnswer);
      const aiResults = await Promise.all(
        shortAnswerQs.map((q) =>
          gradeShortAnswerQuestion(q, (answers[q.id] as string) ?? '', locale),
        ),
      );

      if (cancelled) return;

      // 3. Merge results in original question order
      const allResultsMap = new Map<string, QuestionResult>();
      for (const r of [...choiceResults, ...aiResults]) {
        allResultsMap.set(r.questionId, r);
      }
      const ordered = questions.map((q) => allResultsMap.get(q.id)!).filter(Boolean);

      if (!attemptId) {
        setRuntimeGate({ status: 'error' });
        return;
      }
      try {
        await persistQuizReview(
          { stageId, sceneId, attemptId, answers, results: ordered, confidence },
          runtimeWriter,
        );
      } catch (error) {
        log.warn('Failed to persist quiz review:', error);
        if (!cancelled) setRuntimeGate({ status: 'error' });
        return;
      }
      if (cancelled) return;
      // 判分完成了 —— 逐题记「交卷了」。判分服务挂掉时 `correct` 是 null
      // （`gradeShortAnswerQuestion` 的保底半分），那时**仍然要发**：
      // 「他交了但没判出来」是一个事实，不发就等于他没交过。
      for (const result of ordered) {
        recordAnswerSubmitted({ stageId, sceneId, attemptId }, result.questionId, result.correct);
      }
      setResults(ordered);
      setPhase('reviewing');
      emitQuizReviewed(sceneId);
    })();

    return () => {
      cancelled = true;
    };
  }, [phase, questions, answers, confidence, locale, sceneId, stageId, attemptId, runtimeWriter]);

  const handleRetry = useCallback(async () => {
    if (!attemptId || retrying) return;
    setRetrying(true);
    runtimeWriter.cancelDraft();
    await runQuizPersistenceTransition(
      () => persistQuizRetry({ stageId, sceneId, attemptId }, runtimeWriter),
      viewLifetime,
      () => {
        setPhase('not_started');
        setAnswers({});
        setResults([]);
        setRetrying(false);
      },
      (error) => {
        log.warn('Failed to persist quiz retry:', error);
        setRetrying(false);
        if (error instanceof QuizRetryProgressedError) {
          setHydrationVersion((version) => version + 1);
          return;
        }
        setRuntimeGate({ status: 'error' });
      },
    );
  }, [attemptId, retrying, runtimeWriter, sceneId, stageId, viewLifetime]);

  const earnedScore = useMemo(() => results.reduce((sum, r) => sum + r.earned, 0), [results]);

  const resultMap = useMemo(() => {
    const map: Record<string, QuestionResult> = {};
    results.forEach((r) => {
      map[r.questionId] = r;
    });
    return map;
  }, [results]);

  if (runtimeGate.status === 'error') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-900">
        <button
          type="button"
          onClick={() => setHydrationVersion((version) => version + 1)}
          className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700"
        >
          <RotateCcw className="h-4 w-4" />
          {t('quiz.retry')}
        </button>
      </div>
    );
  }

  if (!isQuizRuntimeReady(runtimeGate)) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-900">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-gradient-to-b from-gray-50 to-white dark:from-gray-900 dark:to-gray-900 overflow-hidden flex flex-col">
      <AnimatePresence mode="wait">
        {phase === 'not_started' && (
          <motion.div
            key="cover"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1"
          >
            <QuizCover
              questionCount={questions.length}
              totalPoints={totalPoints}
              onStart={() => setPhase('answering')}
            />
          </motion.div>
        )}

        {phase === 'answering' && (
          <motion.div
            key="answering"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1 flex flex-col min-h-0"
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 backdrop-blur shrink-0">
              <div className="flex items-center gap-2">
                <PieChart className="w-4 h-4 text-violet-500" />
                <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                  {t('quiz.answering')}
                </span>
                <span className="text-xs text-gray-400 ml-1">
                  {
                    Object.keys(answers).filter((k) => {
                      const a = answers[k];
                      if (Array.isArray(a)) return a.length > 0;
                      return typeof a === 'string' && a.trim().length > 0;
                    }).length
                  }{' '}
                  / {questions.length}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                title={
                  !allAnswered
                    ? undefined
                    : confidenceComplete
                      ? undefined
                      : t('quiz.confidence.missing')
                }
                className={cn(
                  'px-4 py-1.5 rounded-lg text-xs font-medium transition-all',
                  canSubmit
                    ? 'bg-gradient-to-r from-violet-500 to-purple-500 text-white shadow-sm hover:shadow-md hover:shadow-violet-200/50 dark:hover:shadow-violet-900/50 active:scale-[0.97]'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed',
                )}
              >
                {t('quiz.submitAnswers')}
              </button>
            </div>

            {/* Questions */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {questions.map((q, i) => {
                if (q.type === 'single') {
                  return (
                    <SingleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string | undefined}
                      onChange={(v) => handleSetAnswer(q.id, v)}
                      confidence={confidenceOf(confidence, q.id)}
                      onConfidence={(level) => handleSetConfidence(q.id, level)}
                    />
                  );
                }
                if (q.type === 'multiple') {
                  return (
                    <MultipleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string[] | undefined}
                      onChange={(v) => handleSetAnswer(q.id, v)}
                      confidence={confidenceOf(confidence, q.id)}
                      onConfidence={(level) => handleSetConfidence(q.id, level)}
                    />
                  );
                }
                return (
                  <ShortAnswerQuestion
                    key={q.id}
                    question={q}
                    index={i}
                    value={answers[q.id] as string | undefined}
                    onChange={(v) => handleSetAnswer(q.id, v)}
                    confidence={confidenceOf(confidence, q.id)}
                    onConfidence={(level) => handleSetConfidence(q.id, level)}
                  />
                );
              })}
            </div>
          </motion.div>
        )}

        {(phase === 'submitting' || phase === 'grading') && (
          <motion.div
            key="grading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 flex flex-col items-center justify-center gap-5"
          >
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}
            >
              <Loader2 className="w-10 h-10 text-violet-500" />
            </motion.div>
            <div className="text-center">
              <p className="text-base font-semibold text-gray-700 dark:text-gray-200">
                {t('quiz.aiGrading')}
              </p>
              <p className="text-sm text-gray-400 mt-1">{t('quiz.aiGradingWait')}</p>
            </div>
            <div className="flex gap-1 mt-2">
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  className="w-2 h-2 rounded-full bg-violet-400"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{
                    repeat: Infinity,
                    duration: 1.2,
                    delay: i * 0.2,
                  }}
                />
              ))}
            </div>
          </motion.div>
        )}

        {phase === 'reviewing' && (
          <motion.div
            key="reviewing"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex-1 flex flex-col min-h-0"
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 backdrop-blur shrink-0">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                  {t('quiz.quizReport')}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleRetry()}
                disabled={retrying}
                className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {t('quiz.retry')}
              </button>
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              <ScoreBanner score={earnedScore} total={totalPoints} results={results} />
              <CalibrationBanner results={results} confidence={confidence} />

              {questions.map((q, i) => {
                const r = resultMap[q.id];
                if (q.type === 'single') {
                  return (
                    <SingleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string | undefined}
                      onChange={() => {}}
                      disabled
                      result={r}
                    />
                  );
                }
                if (q.type === 'multiple') {
                  return (
                    <MultipleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string[] | undefined}
                      onChange={() => {}}
                      disabled
                      result={r}
                    />
                  );
                }
                return (
                  <ShortAnswerQuestion
                    key={q.id}
                    question={q}
                    index={i}
                    value={answers[q.id] as string | undefined}
                    onChange={() => {}}
                    disabled
                    result={r}
                  />
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
