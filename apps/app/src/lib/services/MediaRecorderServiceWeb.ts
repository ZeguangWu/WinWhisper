import {
	type MutationFn,
	Ok,
	type QueryFn,
	type Result,
	createServiceErrorFns,
} from '@epicenterhq/result';
import type { WhisperingErrProperties } from '@repo/shared';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { nanoid } from 'nanoid/non-secure';
import { toast } from './ToastService.js';

const TIMESLICE_MS = 1000;

type MediaRecorderErrProperties = WhisperingErrProperties;

type MediaRecorderService = {
	enumerateRecordingDevices: QueryFn<
		void,
		Pick<MediaDeviceInfo, 'deviceId' | 'label'>[],
		MediaRecorderErrProperties
	>;
	initRecordingSession: MutationFn<
		RecordingSessionSettings,
		void,
		MediaRecorderErrProperties
	>;
	closeRecordingSession: MutationFn<void, void, MediaRecorderErrProperties>;
	startRecording: MutationFn<
		{ recordingId: string },
		void,
		MediaRecorderErrProperties
	>;
	stopRecording: MutationFn<void, Blob, MediaRecorderErrProperties>;
	cancelRecording: MutationFn<void, void, MediaRecorderErrProperties>;
};

type RecordingSession = {
	settings: RecordingSessionSettings;
	stream: MediaStream;
	recorder: {
		mediaRecorder: MediaRecorder;
		recordedChunks: Blob[];
		recordingId: string;
	} | null;
};

type RecordingSessionSettings = {
	deviceId: string;
	bitsPerSecond: number;
};

const { Err, tryAsync } = createServiceErrorFns<MediaRecorderErrProperties>();

export const createMediaRecorderServiceWeb = (): MediaRecorderService => {
	let currentSession: RecordingSession | null = null;

	const acquireStreamAndSetUpRecordingSession: MutationFn<
		RecordingSessionSettings,
		MediaStream,
		MediaRecorderErrProperties
	> = async (settings, { onMutate, onSuccess, onError, onSettled }) => {
		onMutate(settings);
		const getStreamToastId = nanoid();
		if (!settings.deviceId) {
			toast.loading({
				id: getStreamToastId,
				title: 'No device selected',
				description: 'Defaulting to first available audio input device...',
			});
			const getFirstStreamResult = await getFirstAvailableStream();
			if (!getFirstStreamResult.ok) {
				onError({
					_tag: 'WhisperingError',
					title: 'Error acquiring stream',
					description:
						'No device selected and no available audio input devices found',
					action: { type: 'more-details', error: getFirstStreamResult.error },
				});
				onSettled();
				return;
			}
			toast.info({
				id: getStreamToastId,
				title: 'Defaulted to first available audio input device',
				description: 'You can select a specific device in the settings.',
			});
			const firstStream = getFirstStreamResult.data;
			onSuccess(firstStream);
			onSettled();
			return;
		}
		toast.loading({
			id: getStreamToastId,
			title: 'Connecting to selected audio input device...',
			description: 'Please allow access to your microphone if prompted.',
		});
		const getPreferredStreamResult = await getStreamForDeviceId(
			settings.deviceId,
		);
		if (getPreferredStreamResult.ok) {
			const preferredStream = getPreferredStreamResult.data;
			onSuccess(preferredStream);
			onSettled();
			return;
		}
		toast.loading({
			id: getStreamToastId,
			title: 'Error connecting to selected audio input device',
			description: 'Trying to find another available audio input device...',
		});
		const getFirstStreamResult = await getFirstAvailableStream();
		if (!getFirstStreamResult.ok) {
			onError({
				_tag: 'WhisperingError',
				title: 'Error acquiring stream',
				description:
					'Unable to connect to your selected microphone or find any available audio input devices',
				action: { type: 'more-details', error: getFirstStreamResult.error },
			});
			onSettled();
			return;
		}

		toast.info({
			id: getStreamToastId,
			title: 'Defaulted to first available audio input device',
			description: 'You can select a specific device in the settings.',
		});
		const firstStream = getFirstStreamResult.data;
		onSuccess(firstStream);
		onSettled();
		return;
	};

	return {
		enumerateRecordingDevices: async () =>
			tryAsync({
				try: async () => {
					const allAudioDevicesStream =
						await navigator.mediaDevices.getUserMedia({
							audio: true,
						});
					const devices = await navigator.mediaDevices.enumerateDevices();
					for (const track of allAudioDevicesStream.getTracks()) {
						track.stop();
					}
					const audioInputDevices = devices.filter(
						(device) => device.kind === 'audioinput',
					);
					return audioInputDevices;
				},
				catch: (error) => ({
					_tag: 'WhisperingError',
					title: 'Error enumerating recording devices',
					description:
						'Please make sure you have given permission to access your audio devices',
					action: { type: 'more-details', error },
				}),
			}),
		async initRecordingSession(
			settings,
			{ onMutate, onSuccess, onError, onSettled },
		) {
			onMutate(settings);
			if (currentSession) {
				onError({
					_tag: 'WhisperingError',
					title: '⚠️ Session Already Active',
					description: 'A recording session is already running and ready to go',
					action: { type: 'none' },
				});
				onSettled();
				return;
			}
			const initRecordingSessionToastId = nanoid();

			await acquireStreamAndSetUpRecordingSession(settings, {
				onMutate: () => {},
				onSuccess: (stream) => {
					currentSession = { settings, stream, recorder: null };
					onSuccess();
				},
				onError: (error) => {
					onError({
						_tag: 'WhisperingError',
						title: '🎤 Microphone Access Error',
						description: 'Unable to connect to your selected microphone',
						action: { type: 'more-details', error },
					});
				},
				onSettled: () => {},
			});
			onSettled();
		},
		async closeRecordingSession(
			_,
			{ onMutate, onSuccess, onError, onSettled },
		) {
			onMutate();
			if (!currentSession) {
				onError({
					_tag: 'WhisperingError',
					title: '❌ No Active Session',
					description: "There's no recording session to close at the moment",
					action: { type: 'none' },
				});
				return;
			}
			if (currentSession.recorder) {
				onError({
					_tag: 'WhisperingError',
					title: '⏺️ Recording in Progress',
					description:
						'Please stop or cancel your current recording first before closing the session',
					action: {
						type: 'none',
					},
				});
				onSettled();
				return;
			}
			for (const track of currentSession.stream.getTracks()) {
				track.stop();
			}
			currentSession.recorder = null;
			currentSession = null;
			onSuccess();
			onSettled();
		},
		async startRecording(
			{ recordingId },
			{ onMutate, onSuccess, onError, onSettled },
		) {
			onMutate({ recordingId });
			if (!currentSession) {
				onError({
					_tag: 'WhisperingError',
					title: '❌ No Active Session',
					description:
						"There's no recording session to start recording in at the moment",
					action: { type: 'none' },
				});
				onSettled();
				return;
			}
			const { stream, settings } = currentSession;
			if (!stream.active) {
				const refreshRecordingSessionToastId = nanoid();
				toast.loading({
					id: refreshRecordingSessionToastId,
					title: '🔄 Recording Session Expired',
					description:
						'Refreshing your recording session to get you back on track...',
				});
				await acquireStreamAndSetUpRecordingSession(settings, {
					onMutate: () => {},
					onSuccess: (stream) => {
						currentSession = { settings, stream, recorder: null };
					},
					onError: (error) => {
						onError({
							_tag: 'WhisperingError',
							title: '🎤 Microphone Access Error',
							description: 'Unable to connect to your selected microphone',
							action: { type: 'more-details', error },
						});
					},
					onSettled: () => {},
				});
			}
			const newRecorderResult = await tryAsync({
				try: async () =>
					new MediaRecorder(stream, { bitsPerSecond: settings.bitsPerSecond }),
				catch: (error) => ({
					_tag: 'WhisperingError',
					title: '🎙️ Recording Setup Failed',
					description: 'Unable to initialize your microphone. Please try again',
					action: { type: 'more-details', error },
				}),
			});
			if (!newRecorderResult.ok) {
				onError(newRecorderResult.error);
				onSettled();
				return;
			}
			const newRecorder = newRecorderResult.data;
			currentSession.recorder = {
				mediaRecorder: newRecorder,
				recordedChunks: [],
				recordingId,
			};
			newRecorder.addEventListener('dataavailable', (event: BlobEvent) => {
				if (!currentSession || !event.data.size) return;
				currentSession.recorder?.recordedChunks.push(event.data);
			});
			newRecorder.start(TIMESLICE_MS);
			onSuccess();
			onSettled();
		},
		async stopRecording(_, { onMutate, onSuccess, onError, onSettled }) {
			onMutate();
			if (!currentSession?.recorder?.mediaRecorder) {
				onError({
					_tag: 'WhisperingError',
					title: '⚠️ Nothing to Stop',
					description: 'No active recording found to stop',
					action: {
						type: 'none',
					},
				});
				onSettled();
				return;
			}
			const stopResult = await tryAsync({
				try: () =>
					new Promise<Blob>((resolve, reject) => {
						if (!currentSession?.recorder?.mediaRecorder) {
							reject(new Error('No active media recorder'));
							return;
						}
						currentSession.recorder.mediaRecorder.addEventListener(
							'stop',
							() => {
								if (!currentSession?.recorder?.mediaRecorder) {
									reject(
										new Error(
											'Media recorder was nullified before stop event listener',
										),
									);
									return;
								}
								const audioBlob = new Blob(
									currentSession.recorder.recordedChunks,
									{
										type: currentSession.recorder.mediaRecorder.mimeType,
									},
								);
								resolve(audioBlob);
							},
						);
						currentSession.recorder.mediaRecorder.stop();
					}),
				catch: (error) => ({
					_tag: 'WhisperingError',
					title: '⏹️ Recording Stop Failed',
					description: 'Unable to save your recording. Please try again',
					action: { type: 'more-details', error },
				}),
			});
			if (!stopResult.ok) {
				onError(stopResult.error);
				onSettled();
				return;
			}
			const blob = stopResult.data;
			onSuccess(blob);
			onSettled();
		},
		async cancelRecording(_, { onMutate, onSuccess, onError, onSettled }) {
			onMutate();
			if (!currentSession?.recorder?.mediaRecorder) {
				onError({
					_tag: 'WhisperingError',
					title: '⚠️ Nothing to Cancel',
					description: 'No active recording found to cancel',
					action: { type: 'none' },
				});
				onSettled();
				return;
			}
			for (const track of currentSession.stream.getTracks()) {
				track.stop();
			}
			currentSession.recorder.mediaRecorder.stop();
			currentSession.recorder = null;
			onSuccess();
			onSettled();
		},
	};
};

const createMediaRecorderServiceNative = (): MediaRecorderService => {
	return {
		enumerateRecordingDevices: async () => {
			const invokeResult = await invoke<string[]>(
				'enumerate_recording_devices',
			);
			if (!invokeResult.ok) {
				return Err({
					_tag: 'WhisperingError',
					title: 'Error enumerating recording devices',
					description:
						'Please make sure you have given permission to access your audio devices',
					action: { type: 'more-details', error: invokeResult.error },
				});
			}
			const deviceNames = invokeResult.data;
			return Ok(
				deviceNames.map((deviceName) => ({
					deviceId: deviceName,
					label: deviceName,
				})),
			);
		},
		initRecordingSession: async (
			settings,
			{ onMutate, onSuccess, onError, onSettled },
		) => {
			onMutate(settings);
			const result = await invoke('init_recording_session');
			if (result.ok) {
				onSuccess();
			} else {
				onError(result.error);
			}
			onSettled();
		},
		closeRecordingSession: async (
			_,
			{ onMutate, onSuccess, onError, onSettled },
		) => {
			onMutate();
			const result = await invoke('close_recording_session');
			if (result.ok) {
				onSuccess();
			} else {
				onError(result.error);
			}
			onSettled();
		},
		startRecording: async (
			{ recordingId },
			{ onMutate, onSuccess, onError, onSettled },
		) => {
			onMutate({ recordingId });
			const result = await invoke('start_recording');
			if (result.ok) {
				onSuccess();
			} else {
				onError(result.error);
			}
			onSettled();
		},
		stopRecording: async (_, { onMutate, onSuccess, onError, onSettled }) => {
			onMutate();
			const result = await invoke('stop_recording');
			if (result.ok) {
				onSuccess(result.data);
			} else {
				onError(result.error);
			}
			onSettled();
		},
		cancelRecording: async (_, { onMutate, onSuccess, onError, onSettled }) => {
			onMutate();
			const result = await invoke('cancel_recording');
			if (result.ok) {
				onSuccess();
			} else {
				onError(result.error);
			}
			onSettled();
		},
	};
};

async function invoke<T>(
	command: string,
): Promise<Result<T, MediaRecorderErrProperties>> {
	return tryAsync({
		try: async () => await tauriInvoke<T>(command),
		catch: (error) => ({
			_tag: 'WhisperingError',
			title: 'Command Execution Failed',
			description: `Error invoking command ${command}`,
			action: { type: 'more-details', error },
		}),
	});
}

async function getFirstAvailableStream() {
	const recordingDevicesResult = await tryAsync({
		try: async () => {
			const allAudioDevicesStream = await navigator.mediaDevices.getUserMedia({
				audio: true,
			});
			const devices = await navigator.mediaDevices.enumerateDevices();
			for (const track of allAudioDevicesStream.getTracks()) {
				track.stop();
			}
			const audioInputDevices = devices.filter(
				(device) => device.kind === 'audioinput',
			);
			return audioInputDevices;
		},
		catch: (error) => ({
			_tag: 'WhisperingError',
			title:
				'Error enumerating recording devices and acquiring first available stream',
			description:
				'Please make sure you have given permission to access your audio devices',
			action: { type: 'more-details', error },
		}),
	});
	if (!recordingDevicesResult.ok) return recordingDevicesResult;
	const recordingDevices = recordingDevicesResult.data;

	for (const device of recordingDevices) {
		const streamResult = await getStreamForDeviceId(device.deviceId);
		if (streamResult.ok) {
			return streamResult;
		}
	}
	return Err({
		_tag: 'WhisperingError',
		title: '🎤 Microphone Access Error',
		description: 'Unable to connect to your selected microphone',
		action: {
			type: 'more-details',
			error: new Error('No available audio input devices'),
		},
	});
}

async function getStreamForDeviceId(recordingDeviceId: string) {
	return tryAsync({
		try: async () => {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					deviceId: { exact: recordingDeviceId },
					channelCount: 1, // Mono audio is usually sufficient for voice recording
					sampleRate: 16000, // 16 kHz is a good balance for voice
				},
			});
			return stream;
		},
		catch: (error) => ({
			_tag: 'WhisperingError',
			title: '🎤 Microphone Access Error',
			description: 'Unable to connect to your selected microphone',
			action: { type: 'more-details', error },
		}),
	});
}
