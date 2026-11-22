export interface ChromeInstructionActionsInput {
  instruction: string | null;
  available: boolean;
  installUrl: string | null;
  jobState: string | null;
  hasPendingAudio: boolean;
}

export interface ChromeInstructionActions {
  showInstall: boolean;
  showOpenWhatsapp: boolean;
  showRecheck: boolean;
  showRestart: boolean;
  showRetry: boolean;
  showInstallHelp: boolean;
}

const EXTENSION_ISSUE_PATTERN = /extens[aã]o|instale|atualize|respondeu/i;
const WHATSAPP_WEB_ISSUE_PATTERN = /whatsapp web|conecte|aba|conta/i;
const TRANSCRIPTION_ISSUE_PATTERN = /transcri[çc]|áudio|pend[êe]nc/i;

export function selectChromeInstructionActions(
  input: ChromeInstructionActionsInput,
): ChromeInstructionActions {
  const text = (input.instruction || '').trim();
  const isExtensionIssue = !input.available && EXTENSION_ISSUE_PATTERN.test(text);
  const isWhatsappWebIssue = !input.available && WHATSAPP_WEB_ISSUE_PATTERN.test(text);
  const isTranscriptionIssue =
    input.hasPendingAudio ||
    input.jobState === 'failed' ||
    input.jobState === 'awaiting_confirmation' ||
    TRANSCRIPTION_ISSUE_PATTERN.test(text);

  const showInstall = isExtensionIssue && Boolean(input.installUrl);
  const showInstallHelp = isExtensionIssue;
  const showOpenWhatsapp = isWhatsappWebIssue;
  const showRestart = input.jobState === 'uploading';
  const showRetry = isTranscriptionIssue && !isExtensionIssue && !isWhatsappWebIssue;
  const hasSpecificAction = showInstall || showOpenWhatsapp || showRestart || showRetry;
  const showRecheck = !input.available || !hasSpecificAction;

  return {
    showInstall,
    showOpenWhatsapp,
    showRecheck,
    showRestart,
    showRetry,
    showInstallHelp,
  };
}
