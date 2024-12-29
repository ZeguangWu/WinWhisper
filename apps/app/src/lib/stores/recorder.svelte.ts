import {
	ClipboardService,
	NotificationService,
	PlaySoundService,
	RecordingsService,
	SetTrayIconService,
	userConfiguredServices,
} from '$lib/services.svelte';
import { type Recording, recordings } from '$lib/stores/recordings.svelte';
import { settings } from '$lib/stores/settings.svelte';
import { clipboard } from '$lib/utils/clipboard';
import { toast } from '$lib/utils/toast';
import {
	WHISPERING_RECORDINGS_PATHNAME,
	type WhisperingRecordingState,
} from '@repo/shared';
import { nanoid } from 'nanoid/non-secure';

const IS_RECORDING_NOTIFICATION_ID = 'WHISPERING_RECORDING_NOTIFICATION';

export const recorder = createRecorder();

function createRecorder() {
	let recorderState = $state<WhisperingRecordingState>('IDLE');

	const setRecorderState = (newValue: WhisperingRecordingState) => {
		recorderState = newValue;
		void (async () => {
			const result = await SetTrayIconService.setTrayIcon(newValue);
			if (!result.ok) {
				toast.warning({
					title: `🚫 Could not set tray icon to ${recorderState} icon...`,
					description: 'Please check your system tray settings',
					action: { type: 'more-details', error: result.error },
				});
			}
		})();
	};

	const stopRecordingAndTranscribeAndCopyToClipboardAndPasteToCursorWithToast =
		async () => {
			const stopRecordingToastId = nanoid();
			toast.loading({
				id: stopRecordingToastId,
				title: '⏸️ Stopping recording...',
				description: 'Finalizing your audio capture...',
			});

			const stopResult =
				await userConfiguredServices.RecorderService.stopRecording(undefined, {
					sendStatus: (options) =>
						toast.loading({ id: stopRecordingToastId, ...options }),
				});

			if (!stopResult.ok) {
				toast.error({ id: stopRecordingToastId, ...stopResult.error });
				return;
			}
			setRecorderState('SESSION');
			console.info('Recording stopped');
			void PlaySoundService.playSound('stop');

			const blob = stopResult.data;
			const newRecording: Recording = {
				id: nanoid(),
				title: '',
				subtitle: '',
				timestamp: new Date().toISOString(),
				transcribedText: '',
				blob,
				transcriptionStatus: 'UNPROCESSED',
			};

			const saveRecordingToDatabaseResult =
				await RecordingsService.addRecording(newRecording);
			if (!saveRecordingToDatabaseResult.ok) {
				toast.error({
					id: stopRecordingToastId,
					title: '❌ Failed to save recording to database',
					description: 'Recording completed but unable to save to database',
					action: {
						type: 'more-details',
						error: saveRecordingToDatabaseResult.error,
					},
				});
				return;
			}

			toast.loading({
				id: stopRecordingToastId,
				title: '✨ Recording Complete!',
				description: settings.value.isFasterRerecordEnabled
					? 'Recording saved! Ready for another take'
					: 'Recording saved and session closed successfully',
			});

			const [
				_transcribeAndCopyAndPasteWithToastResult,
				_closeSessionIfNeededWithToastResult,
			] = await Promise.all([
				(async () => {
					const transcribeAndUpdateWithToastResult =
						await recordings.transcribeAndUpdateRecordingWithToast(
							newRecording,
							{ toastId: stopRecordingToastId },
						);
					if (!transcribeAndUpdateWithToastResult.ok) return;

					const { transcribedText } = transcribeAndUpdateWithToastResult.data;

					if (settings.value.isCopyToClipboardEnabled) {
						toast.loading({
							id: stopRecordingToastId,
							title: '⏳ Copying to clipboard...',
							description: 'Copying the transcription to your clipboard...',
						});
						const copyResult =
							await ClipboardService.setClipboardText(transcribedText);
						if (!copyResult.ok) {
							toast.warning(copyResult.error);
							toast.success({
								id: stopRecordingToastId,
								title: '📝 Recording transcribed!',
								description:
									"We couldn't copy the transcription to your clipboard, though. You can copy it manually.",
								descriptionClass: 'line-clamp-2',
								action: {
									type: 'button',
									label: 'Copy to clipboard',
									onClick: () =>
										clipboard.copyTextToClipboardWithToast({
											label: 'transcribed text',
											text: transcribedText,
										}),
								},
							});
							return;
						}
					}

					if (!settings.value.isPasteContentsOnSuccessEnabled) {
						toast.success({
							id: stopRecordingToastId,
							title: '📝📋 Recording transcribed and copied to clipboard!',
							description: transcribedText,
							descriptionClass: 'line-clamp-2',
							action: {
								type: 'link',
								label: 'Go to recordings',
								goto: WHISPERING_RECORDINGS_PATHNAME,
							},
						});
						return;
					}
					toast.loading({
						id: stopRecordingToastId,
						title: '⏳ Pasting ...',
						description: 'Pasting the transcription to your cursor...',
					});
					const pasteResult =
						await ClipboardService.writeTextToCursor(transcribedText);
					if (!pasteResult.ok) {
						toast.warning(pasteResult.error);
						toast.success({
							id: stopRecordingToastId,
							title: '📝📋 Recording transcribed and copied to clipboard!',
							description: transcribedText,
							descriptionClass: 'line-clamp-2',
						});
						return;
					}
					toast.success({
						id: stopRecordingToastId,
						title:
							'📝📋✍️ Recording transcribed, copied to clipboard, and pasted!',
						description: transcribedText,
						descriptionClass: 'line-clamp-2',
					});
				})(),
				(async () => {
					if (settings.value.isFasterRerecordEnabled) return;
					toast.loading({
						id: stopRecordingToastId,
						title: '⏳ Closing session...',
						description: 'Wrapping up your recording session...',
					});
					const closeSessionResult =
						await userConfiguredServices.RecorderService.closeRecordingSession(
							undefined,
							{
								sendStatus: (options) =>
									toast.loading({ id: stopRecordingToastId, ...options }),
							},
						);
					if (!closeSessionResult.ok) {
						toast.warning({
							id: stopRecordingToastId,
							title: '⚠️ Unable to close session after recording',
							description:
								'You might need to restart the application to continue recording',
							action: { type: 'more-details', error: closeSessionResult.error },
						});
						return;
					}
					setRecorderState('IDLE');
				})(),
			]);
		};

	const startRecordingWithToast = async () => {
		const startRecordingToastId = nanoid();
		toast.loading({
			id: startRecordingToastId,
			title: '🎙️ Preparing to record...',
			description: 'Setting up your recording environment...',
		});
		if (recorderState === 'IDLE') {
			const initResult =
				await userConfiguredServices.RecorderService.initRecordingSession(
					{
						deviceId: settings.value.selectedAudioInputDeviceId,
						bitsPerSecond: Number(settings.value.bitrateKbps) * 1000,
					},
					{
						sendStatus: (options) =>
							toast.loading({ id: startRecordingToastId, ...options }),
					},
				);
			if (!initResult.ok) {
				toast.error({ id: startRecordingToastId, ...initResult.error });
				return;
			}
			setRecorderState('SESSION');
		}
		const startRecordingResult =
			await userConfiguredServices.RecorderService.startRecording(nanoid(), {
				sendStatus: (options) =>
					toast.loading({ id: startRecordingToastId, ...options }),
			});
		if (!startRecordingResult.ok) {
			toast.error({ id: startRecordingToastId, ...startRecordingResult.error });
			return;
		}
		setRecorderState('SESSION+RECORDING');
		toast.success({
			id: startRecordingToastId,
			title: '🎯 Recording Started!',
			description: 'Your voice is being captured crystal clear',
		});
		console.info('Recording started');
		void PlaySoundService.playSound('start');
		void NotificationService.notify({
			variant: 'info',
			id: IS_RECORDING_NOTIFICATION_ID,
			title: '🎙️ Whispering is recording...',
			description: 'Click to go to recorder',
			action: {
				type: 'link',
				label: 'Go to recorder',
				goto: '/',
			},
		});
	};

	return {
		get recorderState() {
			return recorderState;
		},

		get isInRecordingSession() {
			return (
				recorderState === 'SESSION+RECORDING' || recorderState === 'SESSION'
			);
		},

		closeRecordingSessionWithToast: async () => {
			const toastId = nanoid();
			toast.loading({
				id: toastId,
				title: '⏳ Closing recording session...',
				description: 'Wrapping things up, just a moment...',
			});
			const closeResult =
				await userConfiguredServices.RecorderService.closeRecordingSession(
					undefined,
					{
						sendStatus: (options) => toast.loading({ id: toastId, ...options }),
					},
				);
			if (!closeResult.ok) {
				toast.error({ id: toastId, ...closeResult.error });
				return;
			}
			setRecorderState('IDLE');
			toast.success({
				id: toastId,
				title: '✨ Session Closed Successfully',
				description: 'Your recording session has been neatly wrapped up',
			});
		},

		toggleRecordingWithToast: () => {
			if (recorderState === 'SESSION+RECORDING') {
				void stopRecordingAndTranscribeAndCopyToClipboardAndPasteToCursorWithToast();
			} else {
				void startRecordingWithToast();
			}
		},

		cancelRecordingWithToast: async () => {
			const toastId = nanoid();
			toast.loading({
				id: toastId,
				title: '🔄 Cancelling recording...',
				description: 'Discarding the current recording...',
			});
			const cancelResult =
				await userConfiguredServices.RecorderService.cancelRecording(
					undefined,
					{
						sendStatus: (options) => toast.loading({ id: toastId, ...options }),
					},
				);
			if (!cancelResult.ok) {
				toast.error({ id: toastId, ...cancelResult.error });
				return;
			}
			setRecorderState('SESSION');
			if (settings.value.isFasterRerecordEnabled) {
				toast.success({
					id: toastId,
					title: '🚫 Recording Cancelled',
					description:
						'Recording discarded, but session remains open for a new take',
				});
				setRecorderState('SESSION');
			} else {
				toast.loading({
					id: toastId,
					title: '⏳ Closing session...',
					description: 'Wrapping up your recording session...',
				});
				const closeSessionResult =
					await userConfiguredServices.RecorderService.closeRecordingSession(
						undefined,
						{
							sendStatus: (options) =>
								toast.loading({ id: toastId, ...options }),
						},
					);
				if (!closeSessionResult.ok) {
					toast.error({
						id: toastId,
						title: '❌ Failed to close session while cancelling recording',
						description:
							'Your recording was cancelled but we encountered an issue while closing your session. You may need to restart the application.',
						action: { type: 'more-details', error: closeSessionResult.error },
					});
					return;
				}
				toast.success({
					id: toastId,
					title: '✅ All Done!',
					description: 'Recording cancelled and session closed successfully',
				});
				setRecorderState('IDLE');
			}
			void PlaySoundService.playSound('cancel');
			console.info('Recording cancelled');
		},
	};
}
