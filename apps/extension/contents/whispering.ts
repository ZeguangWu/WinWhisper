import { Console, Effect } from 'effect';
import type { PlasmoCSConfig } from 'plasmo';
import type { ExtensionMessage, WhisperingMessage } from '~lib/commands';
import { localStorageService, type Settings } from '~lib/services/local-storage';

// import { CHATGPT_DOMAINS } from './chatGptButton';

export const config: PlasmoCSConfig = {
	matches: ['http://localhost:5173/*'],
	// exclude_matches: CHATGPT_DOMAINS,
};

export const whisperingCommands = {
	getSettings: () =>
		localStorageService.get({
			key: 'whispering-settings',
			defaultValue: {
				isPlaySoundEnabled: true,
				isCopyToClipboardEnabled: true,
				isPasteContentsOnSuccessEnabled: true,
				selectedAudioInputDeviceId: '',
				currentLocalShortcut: 'space',
				currentGlobalShortcut: '',
				apiKey: '',
				outputLanguage: 'en',
			},
		}),
	setSettings: (settings: Settings) =>
		localStorageService.set({
			key: 'whispering-settings',
			value: settings,
		}),
} as const;

const isWhisperingMessage = (message: ExtensionMessage): message is WhisperingMessage =>
	message.commandName in whisperingCommands;

const _registerListeners = chrome.runtime.onMessage.addListener(
	(message: ExtensionMessage, sender, sendResponse) => {
		const program = Effect.gen(function* () {
			if (!isWhisperingMessage(message)) return false;
			const { commandName, args } = message;
			yield* Console.info('Received message in Whispering content script', { commandName, args });
			const correspondingCommand = whisperingCommands[commandName];
			const response = yield* correspondingCommand(...args);
			yield* Console.info(
				`Responding to invoked command ${commandName} in Whispering content script`,
				{
					response,
				},
			);
			sendResponse(response);
		});
		program.pipe(Effect.runPromise);
		return true; // Will respond asynchronously.
	},
);
