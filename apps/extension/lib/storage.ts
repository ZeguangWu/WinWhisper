import { Storage } from '@plasmohq/storage';
import { useStorage } from '@plasmohq/storage/hook';
import type { Settings, WhisperingRecordingState } from '@repo/shared';
/**
 * Shared state keys used for communication between extension components:
 * - Content Scripts (injected into web pages)
 * - Popup (extension popup UI)
 * - Background Service Worker
 *
 * These keys are used with the Storage API to maintain synchronized state
 * across all extension contexts. Changes to these values will trigger
 * updates in all listening components.
 *
 * @example
 * ```ts
 * // In popup
 * const [recorderState] = useWhisperingStorage<RecorderState>(SHARED_STATE_KEYS.RECORDER_STATE);
 *
 * // In background service worker
 * await storage.setItem(SHARED_STATE_KEYS.RECORDER_STATE, 'SESSION+RECORDING');
 * ```
 */

type WhisperingStorageKeyMap = {
	'whispering-recorder-state': WhisperingRecordingState;
	'whispering-latest-recording-transcribed-text': string;
	'whispering-settings': Settings;
};

export type WhisperingStorageKey = keyof WhisperingStorageKeyMap;

export const whisperingStorage = createWhisperingStorage();

function createWhisperingStorage() {
	const storage = new Storage();
	return {
		setItem: <K extends WhisperingStorageKey>(
			key: K,
			value: WhisperingStorageKeyMap[K],
		) => {
			storage.setItem(key, value);
		},
	};
}

function useWhisperingStorage<T extends WhisperingStorageKey>(
	key: T,
	defaultValue: WhisperingStorageKeyMap[T],
) {
	const [value] = useStorage<WhisperingStorageKeyMap[T]>(key);
	return value ?? defaultValue;
}

export function useWhisperingRecorderState() {
	return useWhisperingStorage('whispering-recorder-state', 'IDLE');
}

export function useWhisperingTranscribedText() {
	return useWhisperingStorage(
		'whispering-latest-recording-transcribed-text',
		'',
	);
}
