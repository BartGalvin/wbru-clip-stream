import { mount } from 'svelte';
import PlayoutLog from './PlayoutLog.svelte';
import './playout.css';

const target = document.getElementById('playout-log');

if (!target) throw new Error('missing #playout-log element');

mount(PlayoutLog, { target });
