import { User } from "lucide-react";
import {
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { presentProviderProtocolText } from "../../../../shared/provider-protocol";
import {
  buildActivitiesFromToolCalls,
  enrichActivitiesWithToolCallDetails,
  finalizeCompletedActivities,
  type LiveActivityItem,
  mergeActivityLists,
  suppressRecoveredWebFailureActivities,
} from "@/lib/chatActivities";
import { chatImageSrc, toolOutputImageSources } from "@/lib/chatImages";
import { cn } from "@/lib/utils";
import { LiveActivityTimeline } from "./ActivityTimeline";
import { assistantAuthorLabel } from "./assistantAuthors";
import { agentAvatarGradient, agentAvatarInitials } from "./BotAvatar";
import { AgentTransferTimeline } from "./AgentTransferTimeline";
import { AssistantMetaInline } from "./AssistantMetaInline";
import { parseTimestampMs } from "./assistantMetaModel";
import { ChatImagePreview } from "./ChatImagePreview";
import { ChatMessageActionRow } from "./ChatMessageActionRow";
import type { ArtifactSummaryView, ChatMessage, RevertTarget } from "./chatModel";
import type { ChatLinkOpenOptions } from "./chatLinkRouting";
import {
  formatToolIntent,
  getMessageProcessActivities,
  normalizeMessageProcessActivities,
} from "./chatModel";
import { MessageContent } from "./MessageContent";
import { ClarifyQuestionCard, clarifyQuestionFromToolCalls } from "./ClarifyQuestionCard";
import { observeDeferredMessage } from "./deferredMessageVisibility";
import { loadDeferredMessageMetadata } from "./deferredMessageMetadata";
import { goalIterationNumber } from "./goalLoopPresentation";
import { interruptedTurnNotice } from "./interruptedTurn";
import { shouldDeferRichMessageContent } from "./messageRenderBudget";
import {
  expandTimelineWindow,
  preservedScrollTop,
  resolveTimelineWindow,
  TIMELINE_PRELOAD_MARGIN_PX,
  type TimelineWindowState,
  timelineWindowStart,
} from "./timelineWindow";

const EMPTY_PROCESS_ACTIVITIES: LiveActivityItem[] = [];

interface VisibleMessageEntry {
  message: ChatMessage;
  originalIndex: number;
  turnStartedAtMs?: number;
}

interface ChatMessageTimelineProps {
  compact?: boolean;
  copiedMessageIndex: number | null;
  entries: VisibleMessageEntry[];
  forkingMessageIndex: number | null;
  goldenTurnsEnabled: boolean;
  liveActivities: LiveActivityItem[];
  liveCurrentStep: string | null;
  liveStatus: "thinking" | "generating" | "compacting" | "idle";
  liveStartedAtMs?: number;
  messageProcessMap: Record<string, LiveActivityItem[]>;
  savingGoldenMessageIndex: number | null;
  sessionId: string | null;
  showAuthorAttribution?: boolean;
  conversationStyle?: boolean;
  showWorkingTimeline: boolean;
  speakingMessageIndex: number | null;
  workspaceDir: string | null;
  onCopyMessage: (index: number, content: string) => void;
  onForkSession: (index: number) => void;
  onOpenArtifact: (artifact: ArtifactSummaryView) => void;
  onOpenImage: (src: string, alt: string) => void;
  onOpenLink: (href: string, options: ChatLinkOpenOptions) => boolean;
  onReadAloud: (index: number, content: string) => void;
  onRevert: (target: RevertTarget) => void;
  onSaveGolden: (index: number) => void;
}

interface ChatMessageRowProps {
  compact: boolean;
  copiedMessageIndex: number | null;
  entry: VisibleMessageEntry;
  forkingMessageIndex: number | null;
  goldenTurnsEnabled: boolean;
  isLatestEntry?: boolean;
  persistedProcessActivities: LiveActivityItem[];
  savingGoldenMessageIndex: number | null;
  sessionId: string | null;
  showAuthorAttribution: boolean;
  conversationStyle: boolean;
  speakingMessageIndex: number | null;
  workspaceDir: string | null;
  onCopyMessage: (index: number, content: string) => void;
  onForkSession: (index: number) => void;
  onOpenArtifact: (artifact: ArtifactSummaryView) => void;
  onOpenImage: (src: string, alt: string) => void;
  onOpenLink: (href: string, options: ChatLinkOpenOptions) => boolean;
  onReadAloud: (index: number, content: string) => void;
  onRevert: (target: RevertTarget) => void;
  onSaveGolden: (index: number) => void;
}

export function ChatMessageTimeline({
  compact = false,
  copiedMessageIndex,
  entries,
  forkingMessageIndex,
  goldenTurnsEnabled,
  liveActivities,
  liveCurrentStep,
  liveStatus,
  liveStartedAtMs,
  messageProcessMap,
  savingGoldenMessageIndex,
  sessionId,
  showAuthorAttribution = false,
  conversationStyle = false,
  showWorkingTimeline,
  speakingMessageIndex,
  workspaceDir,
  onCopyMessage,
  onForkSession,
  onOpenArtifact,
  onOpenImage,
  onOpenLink,
  onReadAloud,
  onRevert,
  onSaveGolden,
}: ChatMessageTimelineProps): ReactElement {
  const latestHandlersRef = useRef({
    onCopyMessage,
    onForkSession,
    onOpenArtifact,
    onOpenImage,
    onOpenLink,
    onReadAloud,
    onRevert,
    onSaveGolden,
  });
  useLayoutEffect(() => {
    latestHandlersRef.current = {
      onCopyMessage,
      onForkSession,
      onOpenArtifact,
      onOpenImage,
      onOpenLink,
      onReadAloud,
      onRevert,
      onSaveGolden,
    };
  });
  const handlers = useMemo(
    () => ({
      onCopyMessage: (index: number, content: string) =>
        latestHandlersRef.current.onCopyMessage(index, content),
      onForkSession: (index: number) => latestHandlersRef.current.onForkSession(index),
      onOpenArtifact: (artifact: ArtifactSummaryView) =>
        latestHandlersRef.current.onOpenArtifact(artifact),
      onOpenImage: (src: string, alt: string) => latestHandlersRef.current.onOpenImage(src, alt),
      onOpenLink: (href: string, options: ChatLinkOpenOptions) =>
        latestHandlersRef.current.onOpenLink(href, options),
      onReadAloud: (index: number, content: string) =>
        latestHandlersRef.current.onReadAloud(index, content),
      onRevert: (target: RevertTarget) => latestHandlersRef.current.onRevert(target),
      onSaveGolden: (index: number) => latestHandlersRef.current.onSaveGolden(index),
    }),
    []
  );

  const windowKey = sessionId ?? null;
  const [windowState, setWindowState] = useState<TimelineWindowState>(() =>
    resolveTimelineWindow(null, windowKey, entries.length)
  );
  const resolvedWindow = resolveTimelineWindow(windowState, windowKey, entries.length);
  if (resolvedWindow !== windowState) setWindowState(resolvedWindow);
  const windowStart = timelineWindowStart(resolvedWindow);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pendingScrollRestoreRef = useRef<{
    scroller: HTMLElement;
    scrollTop: number;
    scrollHeight: number;
  } | null>(null);

  const revealEarlierEntries = useCallback((): void => {
    const scroller = findScrollContainer(sentinelRef.current);
    pendingScrollRestoreRef.current = scroller
      ? { scroller, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight }
      : null;
    setWindowState((current) => expandTimelineWindow(current));
  }, []);

  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current;
    if (!pending) return;
    pendingScrollRestoreRef.current = null;
    pending.scroller.scrollTop = preservedScrollTop(
      pending.scrollTop,
      pending.scrollHeight,
      pending.scroller.scrollHeight
    );
  }, [windowStart]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || windowStart === 0 || typeof window.IntersectionObserver !== "function") {
      return;
    }
    const observer = new window.IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) revealEarlierEntries();
      },
      {
        root: findScrollContainer(sentinel),
        rootMargin: `${TIMELINE_PRELOAD_MARGIN_PX}px 0px 0px 0px`,
      }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [revealEarlierEntries, windowStart]);

  const windowedEntries = windowStart > 0 ? entries.slice(windowStart) : entries;

  return (
    <>
      {windowStart > 0 ? (
        <div ref={sentinelRef} className="flex justify-center py-1" data-timeline-window-sentinel>
          <button
            type="button"
            onClick={revealEarlierEntries}
            className="chat-meta-text rounded-md px-2 py-1 text-gray-500 transition-colors hover:text-gray-300"
          >
            Show {windowStart} earlier messages
          </button>
        </div>
      ) : null}
      {windowedEntries.map((entry, windowIndex) => {
        const visibleIndex = windowStart + windowIndex;
        const goalIteration = goalIterationNumber(entry.message);
        const key = `${entry.message.timestamp || "msg"}-${entry.originalIndex}`;
        if (goalIteration !== null) {
          return (
            <div
              key={key}
              className="flex items-center gap-3 py-1 text-[11px] text-gray-500"
              role="status"
            >
              <div className="h-px flex-1 bg-white/5" />
              <span>Goal iteration {goalIteration}</span>
              <div className="h-px flex-1 bg-white/5" />
            </div>
          );
        }
        const rowProps: ChatMessageRowProps = {
          compact,
          copiedMessageIndex,
          entry,
          forkingMessageIndex,
          goldenTurnsEnabled,
          isLatestEntry: visibleIndex === entries.length - 1,
          persistedProcessActivities: persistedActivitiesForEntry(
            messageProcessMap,
            sessionId,
            entry
          ),
          savingGoldenMessageIndex,
          sessionId,
          showAuthorAttribution,
          conversationStyle,
          speakingMessageIndex,
          workspaceDir,
          ...handlers,
        };
        return shouldDeferRichMessageContent(visibleIndex, entries.length) ? (
          <DeferredChatMessageRow key={key} {...rowProps} />
        ) : (
          <ChatMessageRow key={key} {...rowProps} />
        );
      })}
      {showWorkingTimeline && (
        <div className="w-full min-w-0 py-1">
          <LiveActivityTimeline
            status={liveStatus}
            activities={liveActivities}
            currentStep={liveCurrentStep}
            startedAtMs={liveStartedAtMs}
          />
        </div>
      )}
    </>
  );
}

function persistedActivitiesForEntry(
  map: Record<string, LiveActivityItem[]>,
  sessionId: string | null,
  entry: VisibleMessageEntry
): LiveActivityItem[] {
  const activities = getMessageProcessActivities(
    map,
    sessionId,
    entry.message,
    entry.originalIndex
  );
  return activities.length > 0 ? activities : EMPTY_PROCESS_ACTIVITIES;
}

function findScrollContainer(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null;
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return current;
    current = current.parentElement;
  }
  return null;
}

const DeferredChatMessageRow = memo(function DeferredChatMessageRow(
  props: ChatMessageRowProps
): ReactElement {
  const { message } = props.entry;
  const [richMessage, setRichMessage] = useState<ChatMessage | null>(null);
  const richEntry = useMemo(
    () => (richMessage ? { ...props.entry, message: richMessage } : null),
    [props.entry, richMessage]
  );
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = rowRef.current;
    if (richMessage || !element) return;
    let mounted = true;
    const stopObserving = observeDeferredMessage(element, () => {
      const sessionId = props.sessionId;
      if (!sessionId) {
        setRichMessage(message);
        return;
      }
      void loadDeferredMessageMetadata(sessionId, message).then((hydrated) => {
        if (mounted) setRichMessage(hydrated);
      });
    });
    return () => {
      mounted = false;
      stopObserving();
    };
  }, [message, props.sessionId, richMessage]);
  if (richEntry) {
    return <ChatMessageRow {...props} entry={richEntry} />;
  }
  return (
    <div
      ref={rowRef}
      className={cn(
        "deferred-chat-message flex gap-3",
        message.role === "user" && "flex-row-reverse"
      )}
      data-deferred-rich-content="true"
    >
      {message.role === "user" ? (
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[rgba(var(--accent-primary),0.2)] sm:h-8 sm:w-8">
          <User className="h-3.5 w-3.5 accent-text sm:h-4 sm:w-4" />
        </div>
      ) : null}
      <div
        className={cn(
          "chat-markdown whitespace-pre-wrap break-words text-gray-200",
          message.role === "user"
            ? "max-w-[85%] rounded-xl border border-[rgba(var(--accent-primary),0.2)] px-3 py-2 text-left sm:max-w-[75%] sm:rounded-2xl sm:px-4 sm:py-3 lg:max-w-[65%]"
            : "w-full min-w-0 py-1"
        )}
      >
        {message.content}
      </div>
    </div>
  );
});

const ChatMessageRow = memo(function ChatMessageRow({
  compact,
  copiedMessageIndex,
  entry: { message, originalIndex, turnStartedAtMs },
  forkingMessageIndex,
  goldenTurnsEnabled,
  isLatestEntry,
  persistedProcessActivities,
  savingGoldenMessageIndex,
  sessionId,
  showAuthorAttribution,
  conversationStyle,
  speakingMessageIndex,
  workspaceDir,
  onCopyMessage,
  onForkSession,
  onOpenArtifact,
  onOpenImage,
  onOpenLink,
  onReadAloud,
  onRevert,
  onSaveGolden,
}: ChatMessageRowProps): ReactElement {
  const presentedContent =
    message.role === "assistant"
      ? presentProviderProtocolText(message.content).content
      : message.content;
  const processActivities = useMemo(
    () => completedMessageActivities(message, persistedProcessActivities, turnStartedAtMs),
    [message, persistedProcessActivities, turnStartedAtMs]
  );
  const interactiveClarify = isLatestEntry
    ? clarifyQuestionFromToolCalls(message.tool_calls)
    : null;
  const interruptedNotice = interruptedTurnNotice({ ...message, content: presentedContent });
  return (
    <div
      className={cn(
        "deferred-chat-message flex gap-3",
        message.role === "user" && "flex-row-reverse"
      )}
    >
      {message.role === "user" ? (
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[rgba(var(--accent-primary),0.2)] sm:h-8 sm:w-8">
          <User className="h-3.5 w-3.5 accent-text sm:h-4 sm:w-4" />
        </div>
      ) : conversationStyle ? (
        <AssistantAvatar message={message} />
      ) : null}
      <div
        className={
          message.role === "user"
            ? "max-w-[85%] text-left sm:max-w-[75%] lg:max-w-[65%]"
            : conversationStyle
              ? "min-w-0 max-w-[88%] sm:max-w-[78%] lg:max-w-[70%]"
              : "w-full min-w-0"
        }
      >
        <div
          className={
            message.role === "user"
              ? "rounded-xl border border-[rgba(var(--accent-primary),0.2)] px-3 py-2 sm:rounded-2xl sm:px-4 sm:py-3"
              : conversationStyle
                ? "rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 sm:rounded-2xl sm:px-4 sm:py-3"
                : "py-1"
          }
        >
          {message.role !== "user" && showAuthorAttribution ? (
            <AssistantAuthorLabel message={message} />
          ) : null}
          {message.role !== "user" ? (
            <AssistantMetaInline
              message={message}
              processActivities={processActivities}
              sessionId={sessionId}
              turnStartedAtMs={turnStartedAtMs}
              onOpenArtifact={onOpenArtifact}
              section="work"
              workspaceDir={workspaceDir}
            />
          ) : null}
          <AgentTransferTimeline transfers={message.agent_transfers} />
          {message.images && message.images.length > 0 ? (
            <div
              className={cn(
                "flex flex-wrap gap-2",
                presentedContent && "mb-2",
                message.role === "user" && "justify-end"
              )}
            >
              {message.images.map((image, imageIndex) => {
                const src = chatImageSrc(image);
                if (!src) return null;
                const alt = image.name || "Attachment";
                return (
                  <ChatImagePreview
                    key={`msg-image-${originalIndex}-${imageIndex}`}
                    source={src}
                    alt={alt}
                    width={220}
                    height={165}
                    className="aspect-[4/3] max-h-64 w-full object-contain"
                    containerClassName="block max-w-[220px] cursor-zoom-in overflow-hidden rounded-lg border border-white/12"
                    onOpen={onOpenImage}
                  />
                );
              })}
            </div>
          ) : null}
          <MessageContent
            content={presentedContent}
            onOpenImage={onOpenImage}
            onOpenLink={onOpenLink}
          />
          {interruptedNotice ? (
            <div
              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-[var(--text-secondary)]"
              data-testid="interrupted-turn-notice"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400/80" aria-hidden="true" />
              {interruptedNotice}
            </div>
          ) : null}
          {message.role !== "user" && interactiveClarify ? (
            <ClarifyQuestionCard interactive question={interactiveClarify} sessionId={sessionId} />
          ) : null}
          {message.role !== "user" ? (
            <ToolOutputImages
              message={message}
              messageIndex={originalIndex}
              onOpenImage={onOpenImage}
            />
          ) : null}
          {message.role !== "user" ? (
            <AssistantMetaInline
              message={message}
              processActivities={processActivities}
              sessionId={sessionId}
              turnStartedAtMs={turnStartedAtMs}
              onOpenArtifact={onOpenArtifact}
              section="summary"
              workspaceDir={workspaceDir}
            />
          ) : null}
        </div>
        <ChatMessageActionRow
          compact={compact}
          content={presentedContent}
          copiedMessageIndex={copiedMessageIndex}
          forkingMessageIndex={forkingMessageIndex}
          goldenTurnsEnabled={goldenTurnsEnabled}
          messageIndex={originalIndex}
          role={message.role}
          savingGoldenMessageIndex={savingGoldenMessageIndex}
          sessionId={sessionId}
          speakingMessageIndex={speakingMessageIndex}
          timestamp={message.timestamp}
          onCopyMessage={onCopyMessage}
          onForkSession={onForkSession}
          onReadAloud={onReadAloud}
          onRevert={(index) =>
            onRevert({
              index,
              content: presentedContent,
              timestamp: message.timestamp,
            })
          }
          onSaveGolden={onSaveGolden}
        />
      </div>
    </div>
  );
});

function completedMessageActivities(
  message: ChatMessage,
  persistedProcessActivities: LiveActivityItem[],
  turnStartedAtMs: number | undefined
): LiveActivityItem[] | undefined {
  const embeddedProcessActivities = normalizeMessageProcessActivities(
    message.process_activities,
    parseTimestampMs(message.timestamp) ?? turnStartedAtMs
  );
  const restoredProcessActivities = mergeActivityLists(
    persistedProcessActivities,
    embeddedProcessActivities
  );
  const fallbackToolActivities =
    restoredProcessActivities.length === 0
      ? buildActivitiesFromToolCalls(message.tool_calls, formatToolIntent, {
          baseTimestampMs: parseTimestampMs(message.timestamp) ?? turnStartedAtMs ?? 0,
        })
      : [];
  const mergedActivities = suppressRecoveredWebFailureActivities(
    mergeActivityLists(restoredProcessActivities, fallbackToolActivities),
    message.tool_calls
  );
  const completedActivities =
    mergedActivities.length > 0 ? finalizeCompletedActivities(mergedActivities) : [];
  const detailedActivities = enrichActivitiesWithToolCallDetails(
    completedActivities,
    message.tool_calls
  );
  return detailedActivities.length > 0 ? detailedActivities : undefined;
}

function AssistantAvatar({ message }: { message: ChatMessage }): ReactElement {
  const seed = message.agent_id || message.agent_name || "assistant";
  const name = message.agent_name || "AI";
  return (
    <span
      className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white sm:h-8 sm:w-8"
      style={{ background: agentAvatarGradient(seed) }}
      aria-hidden="true"
    >
      {agentAvatarInitials(name)}
    </span>
  );
}

function AssistantAuthorLabel({ message }: { message: ChatMessage }): ReactElement | null {
  const label = assistantAuthorLabel(message);
  if (!label) return null;
  return (
    <div className="chat-meta-text mb-1.5 inline-flex items-center rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 leading-none text-gray-400">
      {label}
    </div>
  );
}

function ToolOutputImages({
  message,
  messageIndex,
  onOpenImage,
}: {
  message: ChatMessage;
  messageIndex: number;
  onOpenImage: (src: string, alt: string) => void;
}): ReactElement | null {
  const outputImages = toolOutputImageSources(message.tool_calls || [], message.content);
  if (outputImages.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {outputImages.map((src, imageIndex) => (
        <ChatImagePreview
          key={`tool-image-${messageIndex}-${imageIndex}`}
          source={src}
          alt="Tool output"
          width={320}
          height={200}
          className="aspect-[16/10] max-h-80 w-full object-contain"
          containerClassName="block max-w-[320px] cursor-zoom-in overflow-hidden rounded-lg border border-white/12"
          onOpen={onOpenImage}
        />
      ))}
    </div>
  );
}
