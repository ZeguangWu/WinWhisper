<script lang="ts">
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import { cn } from '$lib/utils';
	import {
		MoonIcon,
		SettingsIcon,
		SunIcon,
	} from 'lucide-svelte';
	import { toggleMode } from 'mode-watcher';

	let { class: className }: { class?: string } = $props();
</script>

<nav
	class={cn('flex items-center gap-1.5', className)}
	style="view-transition-name: nav"
>
	<WhisperingButton
		tooltipContent="Settings"
		href="/settings"
		variant="ghost"
		size="icon"
	>
		<SettingsIcon class="h-4 w-4" aria-hidden="true" />
	</WhisperingButton>
	<WhisperingButton
		tooltipContent="Toggle dark mode"
		onclick={toggleMode}
		variant="ghost"
		size="icon"
	>
		<SunIcon
			class="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0"
		/>
		<MoonIcon
			class="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100"
		/>
	</WhisperingButton>
</nav>

<style>
	@keyframes ping {
		75%,
		100% {
			transform: scale(2);
			opacity: 0;
		}
	}

	.animate-ping {
		animation: ping 1s cubic-bezier(0, 0, 0.2, 1) infinite;
	}
</style>
