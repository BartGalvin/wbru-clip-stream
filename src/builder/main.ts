import { mount } from 'svelte';
import Builder from './Builder.svelte';
import './builder.css';

mount(Builder, { target: document.getElementById('app') as HTMLElement });
