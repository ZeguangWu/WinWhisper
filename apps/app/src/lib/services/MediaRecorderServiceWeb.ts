import { settings } from '$lib/stores/settings.svelte.js';
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
		async initRecordingSession(settings, { onSuccess, onError }) {
			if (currentSession) {
				onError({
					_tag: 'WhisperingError',
					title: '⚠️ Session Already Active',
					description: 'A recording session is already running and ready to go',
					action: { type: 'none' },
				});
				return;
			}

			const getStreamForDeviceIdResult = await getStreamForDeviceId(
				settings.deviceId,
			);
			if (!getStreamForDeviceIdResult.ok) {
				onError(getStreamForDeviceIdResult.error);
				return;
			}
			const stream = getStreamForDeviceIdResult.data;
			currentSession = { settings, stream, recorder: null };
			onSuccess();
		},
		async closeRecordingSession(_, { onSuccess, onError }) {
			if (!currentSession) {
				onError({
					_tag: 'WhisperingError',
					title: '❌ No Active Session',
					description: "There's no recording session to close at the moment",
					action: { type: 'none' },
				});
				return;
			}
			const { recorder } = currentSession;
			if (recorder) {
				onError({
					_tag: 'WhisperingError',
					title: '⏺️ Recording in Progress',
					description:
						'Please stop or cancel your current recording first before closing the session',
					action: {
						type: 'none',
					},
				});
				return;
			}
			for (const track of currentSession.stream.getTracks()) {
				track.stop();
			}
			currentSession.recorder = null;
			currentSession = null;
			onSuccess();
		},
		async startRecording({ recordingId }, { onSuccess, onError }) {
			if (!currentSession) {
				onError({
					_tag: 'WhisperingError',
					title: '❌ No Active Session',
					description:
						"There's no recording session to start recording in at the moment",
					action: { type: 'none' },
				});
				return;
			}
			const {
				stream,
				settings: { bitsPerSecond },
			} = currentSession;
			const newRecorderResult = await tryAsync({
				try: async () => new MediaRecorder(stream, { bitsPerSecond }),
				catch: (error) => ({
					_tag: 'WhisperingError',
					title: '🎙️ Recording Setup Failed',
					description: 'Unable to initialize your microphone. Please try again',
					action: { type: 'more-details', error },
				}),
			});
			if (!newRecorderResult.ok) {
				onError(newRecorderResult.error);
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
		},
		async stopRecording(_, { onSuccess, onError }) {
			if (!currentSession?.recorder?.mediaRecorder) {
				onError({
					_tag: 'WhisperingError',
					title: '⚠️ Nothing to Stop',
					description: 'No active recording found to stop',
					action: {
						type: 'none',
					},
				});
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
				return;
			}
			const blob = stopResult.data;
			onSuccess(blob);
		},
		async cancelRecording(_, { onSuccess, onError }) {
			if (!currentSession?.recorder?.mediaRecorder) {
				onError({
					_tag: 'WhisperingError',
					title: '⚠️ Nothing to Cancel',
					description: 'No active recording found to cancel',
					action: { type: 'none' },
				});
				return;
			}
			for (const track of currentSession.stream.getTracks()) {
				track.stop();
			}
			currentSession.recorder.mediaRecorder.stop();
			currentSession.recorder = null;
			onSuccess();
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
		initRecordingSession: async () => invoke('init_recording_session'),
		closeRecordingSession: async () => invoke('close_recording_session'),
		startRecording: async () => invoke('start_recording'),
		stopRecording: async () => invoke('stop_recording'),
		cancelRecording: async () => invoke('cancel_recording'),
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

const toastId = nanoid();
toast.loading({
	id: toastId,
	title: 'Connecting to selected audio input device...',
	description: 'Please allow access to your microphone if prompted.',
});
if (!settings.value.selectedAudioInputDeviceId) {
	toast.loading({
		id: toastId,
		title: 'No device selected',
		description: 'Defaulting to first available audio input device...',
	});
}
toast.info({
	id: toastId,
	title: 'Defaulted to first available audio input device',
	description: 'You can select a specific device in the settings.',
});
toast.success({
	id: toastId,
	title: 'Connected to selected audio input device',
	description: 'Successfully connected to your microphone stream.',
});
toast.loading({
	id: toastId,
	title: 'Error connecting to selected audio input device',
	description: 'Trying to find another available audio input device...',
});
toast.info({
	id: toastId,
	title: 'Defaulted to first available audio input device',
	description: 'You can select a specific device in the settings.',
});
toast.loading({
	title: 'Existing recording session not found',
	description: 'Creating a new recording session...',
});
toast.error({
	title: 'Error creating new recording session',
	description: 'Please try again',
});
toast.loading({
	title: 'Recording session created',
	description: 'Recording in progress...',
});
toast.loading({
	title: 'Existing recording session is inactive',
	description: 'Refreshing recording session...',
});
toast.loading({
	title: 'Error initializing media recorder with preferred device',
	description: 'Trying to find another available audio input device...',
});

const OpenStreamDoesNotExistErr = WhisperingErr({
	_tag: 'WhisperingError',
	title: '🎤 Microphone Setup Needed',
	description: 'Looking for alternative audio devices to get you started...',
	action: {
		type: 'link',
		label: 'Open Settings',
		goto: '/settings',
	},
} as const);

const OpenStreamIsInactiveErr = WhisperingErr({
	_tag: 'WhisperingError',
	title: '🔄 Recording Session Expired',
	description: 'Refreshing your recording session to get you back on track...',
	action: {
		type: 'none',
	},
} as const);

const NoAvailableAudioInputDevicesErr = WhisperingErr({
	_tag: 'WhisperingError',
	title: '🎙️ No Microphone Found',
	description: 'Connect a microphone to start recording your awesome content',
	action: {
		type: 'link',
		label: 'Open Settings',
		goto: '/settings',
	},
} as const);

async function getFirstAvailableStream({
	onSuccess,
	onError,
}: {
	onSuccess: (stream: MediaStream, deviceId: string) => void;
	onError: (error: typeof NoAvailableAudioInputDevicesErr) => void;
}) {
	const recordingDevicesResult = await (async () => {
		return tryAsync({
			try: async () => {
				const allAudioDevicesStream = await navigator.mediaDevices.getUserMedia(
					{
						audio: true,
					},
				);
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
				action: {
					type: 'more-details',
					error,
				},
			}),
		});
	})();
	if (!recordingDevicesResult.ok) return recordingDevicesResult;
	const recordingDevices = recordingDevicesResult.data;

	for (const device of recordingDevices) {
		const streamResult = await getStreamForDeviceId(device.deviceId);
		if (streamResult.ok) {
			onSuccess(streamResult.data, device.deviceId);
			return streamResult;
		}
	}
	onError(NoAvailableAudioInputDevicesErr);
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
