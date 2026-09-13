/* ============ SHARED AUDIO CONTEXT ============ */
        /* One AudioContext for everything (music + effects) so they always
           stay in sync and we never spin up duplicate contexts. */
        let sharedAudioCtx = null;

        function getSharedAudioContext() {
            if (!sharedAudioCtx) {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (!AudioCtx) return null;
                sharedAudioCtx = new AudioCtx();
            }
            if (sharedAudioCtx.state === 'suspended') {
                sharedAudioCtx.resume().catch(() => {});
            }
            return sharedAudioCtx;
        }

        // Browsers block audio until a user gesture; unlock as soon as one
        // happens so both music and effects work once the viewer interacts.
        ['pointerdown', 'touchstart', 'keydown'].forEach(evt => {
            document.addEventListener(evt, getSharedAudioContext, { once: true, passive: true });
        });

        /* ============ MUSIC MANAGER ============ */
        /* Subtle, looping background pad for the GamHub Jobs tips experience. No
           audio asset exists in the project, so this is synthesized — but
           it's isolated behind start()/stop()/duck() so it can be swapped
           for a real music file later (e.g. an <audio>/buffer source
           feeding the same masterGain) without touching quiz logic or any
           of the call sites below. Lowest priority in the audio mix: it
           never affects effect volumes, only the reverse (see duck()). */
        const MusicManager = (function () {
            const BASE_VOLUME = 0.05;   // very low, sits under everything else
            const DUCK_VOLUME = 0.016;  // briefly dipped while an effect plays

            let masterGain = null;
            let lfo = null;
            let voices = [];
            let playing = false;
            let duckResetTimeout = null;

            // A gentle I-IV-V-I progression (Cmaj7 -> Fmaj7 -> G -> Cmaj7)
            // arpeggiated over the pedal-tone pad below, giving the loop an
            // actual sense of forward motion/resolution ("career growth")
            // rather than sitting on one static chord. Scheduled with
            // lookahead (rather than setInterval) so it never drifts.
            const ARP_PATTERN = [
                261.63, 329.63, 392.0, 493.88,   // Cmaj7  (C4 E4 G4 B4)
                349.23, 440.0, 523.25, 659.25,   // Fmaj7  (F4 A4 C5 E5)
                392.0, 493.88, 587.33, 783.99,   // G      (G4 B4 D5 G5)
                261.63, 329.63, 392.0, 523.25    // Cmaj7  (C4 E4 G4 C5, resolving)
            ];
            const ARP_NOTE_INTERVAL = 0.5;
            const ARP_NOTE_GAIN = 0.3;
            let arpStep = 0;
            let nextArpTime = 0;
            let arpSchedulerId = null;

            function buildPad(context, destination) {
                // A grounded, consonant pedal tone (C3-G3-C4 — root, fifth,
                // octave) instead of a full chord: it sits comfortably under
                // every chord in the arpeggio above without clashing, for a
                // calmer, more "focused" texture than the previous version.
                const notes = [
                    { freq: 130.81, type: 'sine', gain: 0.5 },      // C3
                    { freq: 196.0, type: 'triangle', gain: 0.3 },   // G3
                    { freq: 261.63, type: 'sine', gain: 0.22 }      // C4 (light shimmer)
                ];

                return notes.map((note) => {
                    const osc = context.createOscillator();
                    osc.type = note.type;
                    osc.frequency.setValueAtTime(note.freq, context.currentTime);

                    const voiceGain = context.createGain();
                    voiceGain.gain.setValueAtTime(note.gain, context.currentTime);

                    osc.connect(voiceGain);
                    voiceGain.connect(destination);
                    osc.start();

                    return osc;
                });
            }

            function playArpNote(context, freq, time) {
                if (!masterGain) return;
                const osc = context.createOscillator();
                const noteGain = context.createGain();

                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, time);

                noteGain.gain.setValueAtTime(0.0001, time);
                noteGain.gain.exponentialRampToValueAtTime(ARP_NOTE_GAIN, time + 0.025);
                noteGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.42);

                osc.connect(noteGain);
                noteGain.connect(masterGain);

                osc.start(time);
                osc.stop(time + 0.46);
            }

            function scheduleArp(context) {
                if (!playing) return;
                // Lookahead scheduling (queue notes ~200ms ahead) instead of
                // setInterval, so the tempo never drifts and nothing can
                // double-schedule the same beat.
                while (nextArpTime < context.currentTime + 0.2) {
                    playArpNote(context, ARP_PATTERN[arpStep % ARP_PATTERN.length], nextArpTime);
                    nextArpTime += ARP_NOTE_INTERVAL;
                    arpStep++;
                }
                arpSchedulerId = setTimeout(() => scheduleArp(context), 60);
            }

            function start() {
                if (playing) return; // never create a second instance
                const context = getSharedAudioContext();
                if (!context) return;

                masterGain = context.createGain();
                masterGain.gain.setValueAtTime(0.0001, context.currentTime);
                masterGain.gain.linearRampToValueAtTime(BASE_VOLUME, context.currentTime + 2);
                masterGain.connect(context.destination);

                // A slow, gentle breathing movement so the loop never feels
                // static or draws attention to itself.
                lfo = context.createOscillator();
                lfo.type = 'sine';
                lfo.frequency.setValueAtTime(0.07, context.currentTime);
                const lfoGain = context.createGain();
                lfoGain.gain.setValueAtTime(BASE_VOLUME * 0.2, context.currentTime);
                lfo.connect(lfoGain);
                lfoGain.connect(masterGain.gain);
                lfo.start();

                voices = buildPad(context, masterGain);
                playing = true;

                arpStep = 0;
                nextArpTime = context.currentTime + 0.6;
                scheduleArp(context);
            }

            function stop() {
                if (!playing) return;
                const context = getSharedAudioContext();
                if (context && masterGain) {
                    masterGain.gain.cancelScheduledValues(context.currentTime);
                    masterGain.gain.linearRampToValueAtTime(0.0001, context.currentTime + 0.6);
                }

                const voicesToStop = voices;
                const lfoToStop = lfo;
                setTimeout(() => {
                    voicesToStop.forEach(o => { try { o.stop(); } catch (e) {} });
                    if (lfoToStop) { try { lfoToStop.stop(); } catch (e) {} }
                }, 650);

                voices = [];
                lfo = null;
                masterGain = null;
                playing = false;
                clearTimeout(duckResetTimeout);
                clearTimeout(arpSchedulerId);
                arpSchedulerId = null;
            }

            // Briefly lower the music so a sound effect reads clearly, then
            // smoothly restore it. Safe to call repeatedly/overlappingly —
            // each call just re-schedules the same restore.
            function duck(holdMs) {
                if (!playing || !masterGain) return;
                const context = getSharedAudioContext();
                if (!context) return;

                clearTimeout(duckResetTimeout);
                masterGain.gain.cancelScheduledValues(context.currentTime);
                masterGain.gain.setTargetAtTime(DUCK_VOLUME, context.currentTime, 0.05);

                duckResetTimeout = setTimeout(() => {
                    if (!playing || !masterGain) return;
                    masterGain.gain.setTargetAtTime(BASE_VOLUME, context.currentTime, 0.3);
                }, holdMs || 350);
            }

            return { start, stop, duck };
        })();

        /* ============ AUDIO MANAGER ============ */
        /* Centralized, single-instance sound effects via the Web Audio API.
           No audio assets exist in this codebase yet, so effects are
           synthesized rather than adding new file dependencies. Every sound
           goes through this manager so a new instance always stops/replaces
           any previous instance of the same sound — nothing can stack or
           overlap, no matter how quickly stages change. Each effect also
           ducks the background music briefly so it always reads clearly
           over the music (effects outrank music in the mix; music never
           affects effects). */
        const AudioManager = (function () {
            const active = {};

            function getContext() {
                return getSharedAudioContext();
            }

            function stop(key) {
                const entry = active[key];
                if (entry) {
                    try { entry.stop(); } catch (e) { /* already stopped */ }
                    delete active[key];
                }
            }

            function playSwoosh(key, options) {
                const context = getContext();
                if (!context) return;
                stop(key);

                const opts = options || {};
                const duration = opts.duration || 0.32;
                const startFreq = opts.startFreq || 1400;
                const endFreq = opts.endFreq || 300;
                const volume = opts.volume || 0.22;

                const bufferSize = Math.floor(context.sampleRate * duration);
                const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
                const data = buffer.getChannelData(0);
                for (let i = 0; i < bufferSize; i++) {
                    data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
                }

                const noise = context.createBufferSource();
                noise.buffer = buffer;

                const filter = context.createBiquadFilter();
                filter.type = 'bandpass';
                filter.frequency.setValueAtTime(startFreq, context.currentTime);
                filter.frequency.exponentialRampToValueAtTime(endFreq, context.currentTime + duration);

                const gain = context.createGain();
                gain.gain.setValueAtTime(0.0001, context.currentTime);
                gain.gain.exponentialRampToValueAtTime(volume, context.currentTime + 0.04);
                gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);

                noise.connect(filter);
                filter.connect(gain);
                gain.connect(context.destination);

                noise.start();
                noise.stop(context.currentTime + duration);

                active[key] = { stop: () => { try { noise.stop(); } catch (e) {} } };
                noise.onended = () => { delete active[key]; };

                MusicManager.duck(duration * 1000 + 150);
            }

            function playPop(key) {
                const context = getContext();
                if (!context) return;
                stop(key);

                const osc = context.createOscillator();
                const gain = context.createGain();

                osc.type = 'sine';
                osc.frequency.setValueAtTime(520, context.currentTime);
                osc.frequency.exponentialRampToValueAtTime(900, context.currentTime + 0.09);

                gain.gain.setValueAtTime(0.0001, context.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.28, context.currentTime + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.2);

                osc.connect(gain);
                gain.connect(context.destination);

                osc.start();
                osc.stop(context.currentTime + 0.22);

                active[key] = { stop: () => { try { osc.stop(); } catch (e) {} } };
                osc.onended = () => { delete active[key]; };

                MusicManager.duck(350);
            }

            function playTick(key) {
                const context = getContext();
                if (!context) return;
                stop(key);

                const osc = context.createOscillator();
                const gain = context.createGain();

                osc.type = 'square';
                osc.frequency.setValueAtTime(1000, context.currentTime);

                gain.gain.setValueAtTime(0.0001, context.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.1, context.currentTime + 0.005);
                gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.06);

                osc.connect(gain);
                gain.connect(context.destination);

                osc.start();
                osc.stop(context.currentTime + 0.07);

                active[key] = { stop: () => { try { osc.stop(); } catch (e) {} } };
                osc.onended = () => { delete active[key]; };

                MusicManager.duck(150);
            }

            function playDing(key) {
                const context = getContext();
                if (!context) return;
                stop(key);

                // Two-tone E6 -> G6 ding (matches the reference sound design).
                const now = context.currentTime;
                const tones = [
                    { freq: 1318.51, start: now, duration: 0.45, peak: 0.26, attack: 0.005 },        // E6
                    { freq: 1567.98, start: now + 0.09, duration: 0.45, peak: 0.2, attack: 0.005 }   // G6
                ];

                const stopHandles = [];
                let latestEnd = now;

                tones.forEach(({ freq, start, duration, peak, attack }) => {
                    const osc = context.createOscillator();
                    const gain = context.createGain();

                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(freq, start);

                    gain.gain.setValueAtTime(0.0001, start);
                    gain.gain.exponentialRampToValueAtTime(peak, start + attack);
                    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

                    osc.connect(gain);
                    gain.connect(context.destination);

                    osc.start(start);
                    osc.stop(start + duration + 0.02);

                    stopHandles.push(() => { try { osc.stop(); } catch (e) {} });
                    latestEnd = Math.max(latestEnd, start + duration);
                });

                active[key] = { stop: () => { stopHandles.forEach(fn => fn()); } };
                const cleanupDelayMs = (latestEnd - now + 0.05) * 1000;
                setTimeout(() => { delete active[key]; }, cleanupDelayMs);

                MusicManager.duck((latestEnd - now) * 1000 + 150);
            }

            function stopAll() {
                Object.keys(active).forEach(stop);
            }

            return { playSwoosh, playPop, playTick, playDing, stop, stopAll };
        })();

        /* ============ SCREEN SWITCHING ============ */
        function showScreen(name) {
            document.getElementById('opening-screen').classList.toggle('active', name === 'opening');
            document.getElementById('content-screen').classList.toggle('active', name === 'content');
            document.getElementById('share-screen').classList.toggle('active', name === 'share');
        }

        /* ============ SCREEN 1: OPENING HOOK ============ */
        function runOpening() {
            showScreen('opening');
            MusicManager.start(); // begins once, for the whole tips experience
            const texts = document.querySelectorAll('#opening-screen .promo-text');
            const staggerMs = 2500;

            texts.forEach((text, index) => {
                setTimeout(() => {
                    text.classList.add('visible');
                    if (index === texts.length - 1) {
                        text.style.animation = 'fade-in-up 1.5s forwards';
                    }
                }, index * staggerMs);
            });

            const holdAfterReveal = 3000;
            const totalOpeningTime = (texts.length - 1) * staggerMs + holdAfterReveal + 1500;
            setTimeout(startTips, totalOpeningTime);
        }

        /* ============ SCREEN 3: ENGAGEMENT SCREEN ============ */
        function runShareScreen(onComplete) {
            showScreen('share');
            const texts = document.querySelectorAll('#share-screen .promo-text');
            const staggerMs = 2000;

            texts.forEach((text, index) => {
                setTimeout(() => {
                    text.classList.add('visible');
                    if (index === texts.length - 1) {
                        text.style.animation = 'fade-in-up 1.5s forwards';
                    }
                }, index * staggerMs);
            });

            const holdAfterReveal = 3000;
            const totalShareTime = (texts.length - 1) * staggerMs + holdAfterReveal + 1500;

            setTimeout(() => {
                texts.forEach(t => {
                    t.classList.remove('visible');
                    t.style.animation = '';
                });
                onComplete();
            }, totalShareTime);
        }

        /* ============ SCREEN 2: INTERVIEW TIPS DATA ============ */
        /* Flexible content model — a tip's `mistake`/`approach` box can
           carry text only, image only, or both. `image` accepts either a
           remote URL or a local file path; missing/broken images are
           handled gracefully. `type: "interview"` is kept on each entry so
           a future "cv" series can be swapped back in without restructuring
           this array. */
        const DEFAULT_HOOK_READ_TIME = 3000;
        const DEFAULT_TEXT_READ_TIME = 4500;
        const DEFAULT_IMAGE_READ_TIME = 4500;
        const DEFAULT_WHY_READ_TIME = 8000;

const tips = [
            {
                type: "interview",
                title: "INTERVIEW TIP #1",
                prompt: "Which is the better way to answer, \"Tell me about yourself\"?",
                mistake: {
                    text: "Talking about your personal life and everything you've done since childhood."
                },
                approach: {
                    text: "Briefly highlighting your relevant experience, skills, and why they fit the role."
                },
                whyItWorks: {
                    text: "A focused introduction helps the interviewer quickly understand your relevant background and what you can bring to the role.",
                    source: "LinkedIn Talent Solutions",
                    readTime: 9000
                },
                readTime: 6000
            },
            {
                type: "interview",
                title: "INTERVIEW TIP #2",
                prompt: "Which is the stronger answer to \"Why should we hire you?\"?",
                mistake: {
                    text: "\"Because I really need this job and I'll work very hard.\""
                },
                approach: {
                    text: "\"My experience in customer service and problem-solving matches the requirements of this role, and I can contribute from day one.\""
                },
                whyItWorks: {
                    text: "A strong answer connects your skills and experience directly to what the employer needs instead of focusing only on how much you want the job.",
                    source: "University Career Services, Interview Guidance",
                    readTime: 9000
                },
                readTime: 6000
            },
            {
                type: "interview",
                title: "INTERVIEW TIP #3",
                prompt: "Which is the better way to answer \"What's your weakness?\"?",
                mistake: {
                    text: "\"I don't really have any weaknesses. I'm good at everything I do.\""
                },
                approach: {
                    text: "\"I sometimes spend too much time perfecting my work, so I've started setting clear time limits to stay efficient.\""
                },
                whyItWorks: {
                    text: "A specific weakness paired with a genuine improvement strategy demonstrates self-awareness and a willingness to grow.",
                    source: "Society for Human Resource Management (SHRM)",
                    readTime: 9000
                },
                readTime: 5500
            },
            {
                type: "interview",
                title: "INTERVIEW TIP #4",
                prompt: "What is the better approach when asked about your salary expectations?",
                mistake: {
                    text: "Immediately giving a random salary number without knowing the typical range for the position."
                },
                approach: {
                    text: "Researching the market and asking about the employer's budgeted salary range before discussing a specific figure."
                },
                whyItWorks: {
                    text: "Understanding the market and the employer's range gives you better information when discussing compensation and helps you negotiate more confidently.",
                    source: "Glassdoor Salary Research",
                    readTime: 8000
                },
                readTime: 6000
            }
        ];


        let currentTipIndex = 0;
        let stageTimeout;
        let countdownInterval;
        let currentStageToken = 0;

        const progressBadgeElement = document.getElementById('progress-badge');
        const typeTagElement = document.getElementById('type-tag');
        const tipCardElement = document.getElementById('tip-card');
        const timerElement = document.getElementById('timer');
        const countdownElement = document.getElementById('countdown');

        const hookStageElement = document.getElementById('hook-stage');
        const contentStageElement = document.getElementById('content-stage');
        const whyStageElement = document.getElementById('why-stage');

        const hookTextElement = document.getElementById('hook-text');
        const contentTagElement = document.getElementById('content-tag');
        const mistakePanelElement = document.getElementById('mistake-panel');
        const mistakeImageElement = document.getElementById('mistake-image');
        const mistakeTextElement = document.getElementById('mistake-text');
        const approachPanelElement = document.getElementById('approach-panel');
        const approachImageElement = document.getElementById('approach-image');
        const approachTextElement = document.getElementById('approach-text');
        const whyTextElement = document.getElementById('why-text');
        const whySourceElement = document.getElementById('why-source');
        const revealFlashElement = document.getElementById('reveal-flash');

        function startTips() {
            showScreen('content');
            loadTip();
        }

        function setActiveStage(name) {
            hookStageElement.classList.toggle('active', name === 'hook');
            contentStageElement.classList.toggle('active', name === 'content');
            whyStageElement.classList.toggle('active', name === 'why');
        }

        function populateComparePanel(imageEl, textEl, box) {
            const data = box || {};
            const hasText = !!data.text;
            const hasImage = !!data.image;

            if (hasText) {
                textEl.textContent = data.text;
                textEl.style.display = 'block';
            } else {
                textEl.textContent = '';
                textEl.style.display = 'none';
            }

            if (hasImage) {
                imageEl.onerror = function () {
                    // Missing/broken image: hide it and keep the rest of the
                    // tip (the other box, hook, why-it-works) working normally.
                    this.style.display = 'none';
                };
                imageEl.alt = data.imageAlt || '';
                imageEl.style.display = 'block';
                imageEl.src = data.image;
            } else {
                imageEl.onerror = null;
                imageEl.removeAttribute('src');
                imageEl.style.display = 'none';
            }
        }

        function populateContentStage(tip) {
            contentTagElement.textContent = tip.title;
            populateComparePanel(mistakeImageElement, mistakeTextElement, tip.mistake);
            populateComparePanel(approachImageElement, approachTextElement, tip.approach);

            mistakePanelElement.classList.remove('fade-out');
            approachPanelElement.classList.remove('spotlight');
        }

        function getContentStageDuration(tip) {
            const mistake = tip.mistake || {};
            const approach = tip.approach || {};
            const hasText = !!mistake.text || !!approach.text;
            const hasImage = !!mistake.image || !!approach.image;
            const textDuration = tip.readTime || DEFAULT_TEXT_READ_TIME;
            const imageDuration = tip.imageReadTime || DEFAULT_IMAGE_READ_TIME;

            if (hasText && hasImage) {
                return Math.max(textDuration, imageDuration);
            }
            if (hasImage) {
                return imageDuration;
            }
            return textDuration;
        }

        function loadTip() {
            if (currentTipIndex >= tips.length) {
                currentTipIndex = 0;
            }

            // Make sure the content screen is the one showing — this matters
            // right after the share screen, which switches away from it.
            showScreen('content');

            const tip = tips[currentTipIndex];

            progressBadgeElement.childNodes[0].textContent = `TIP ${currentTipIndex + 1}/${tips.length} `;
            typeTagElement.textContent = tip.title;

            hookTextElement.textContent = tip.prompt;
            populateContentStage(tip);
            whyTextElement.textContent = tip.whyItWorks.text;
            if (tip.whyItWorks.source) {
                whySourceElement.textContent = `\u2014 ${tip.whyItWorks.source}`;
                whySourceElement.style.display = 'block';
            } else {
                whySourceElement.textContent = '';
                whySourceElement.style.display = 'none';
            }

            tipCardElement.classList.add('enter');

            setTimeout(() => {
                tipCardElement.classList.remove('enter', 'exit');
                runHookStage(tip);
            }, 50);
        }

        function runHookStage(tip) {
            setActiveStage('hook');
            AudioManager.playSwoosh('reveal', { startFreq: 1700, endFreq: 450, duration: 0.3, volume: 0.22 });
            const duration = tip.hookReadTime || DEFAULT_HOOK_READ_TIME;
            startTimerBar(duration, () => runContentStage(tip));
        }

        function runContentStage(tip) {
            setActiveStage('content');

            // The "reveal" moment: a quick flash + pop as both boxes appear,
            // giving the countdown from the hook stage a payoff.
            revealFlashElement.classList.remove('play');
            contentStageElement.classList.remove('reveal-pop');
            void contentStageElement.offsetWidth;
            revealFlashElement.classList.add('play');
            contentStageElement.classList.add('reveal-pop');
            AudioManager.playSwoosh('cards', { startFreq: 1500, endFreq: 500, duration: 0.28, volume: 0.2 });

            const duration = getContentStageDuration(tip);
            startTimerBar(duration, () => spotlightApproach(tip));
        }

        function spotlightApproach(tip) {
            // The timer has reached zero: reveal the stronger example with a
            // full-card highlight and a single ding, then move on.
            approachPanelElement.classList.add('spotlight');
            mistakePanelElement.classList.add('fade-out');
            AudioManager.playDing('ding');

            setTimeout(() => {
                runWhyStage(tip);
            }, 1800);
        }

        function runWhyStage(tip) {
            setActiveStage('why');
            AudioManager.playPop('why');
            const duration = tip.whyItWorks.readTime || DEFAULT_WHY_READ_TIME;
            startTimerBar(duration, () => transitionToNextTip());
        }

        function clearStageTimer() {
            clearTimeout(stageTimeout);
            clearInterval(countdownInterval);
            AudioManager.stop('timerTick');
        }

        function startTimerBar(duration, onComplete) {
            // Bumping the token invalidates any callback still in flight
            // from a previous stage/tip, so it can never fire against the
            // stage that's replacing it.
            const token = ++currentStageToken;
            clearStageTimer();

            timerElement.classList.remove('ending');
            timerElement.style.transition = 'none';
            timerElement.style.width = '100%';

            void timerElement.offsetWidth;

            timerElement.style.transition = `width ${duration / 1000}s linear, background-color 0.5s`;
            timerElement.style.width = '0%';

            let secondsLeft = Math.ceil(duration / 1000);
            countdownElement.textContent = secondsLeft;
            countdownElement.classList.remove('hidden');

            // One tick per displayed second, synced to the same value the
            // countdown is showing — never a continuous/overlapping sound.
            if (secondsLeft >= 1) {
                AudioManager.playTick('timerTick');
            }

            countdownInterval = setInterval(() => {
                if (token !== currentStageToken) {
                    clearInterval(countdownInterval);
                    return;
                }

                secondsLeft--;
                countdownElement.textContent = Math.max(secondsLeft, 0);

                if (secondsLeft <= 2) {
                    timerElement.classList.add('ending');
                }

                if (secondsLeft >= 1) {
                    AudioManager.playTick('timerTick');
                } else {
                    clearInterval(countdownInterval);
                    AudioManager.stop('timerTick');
                }
            }, 1000);

            stageTimeout = setTimeout(() => {
                if (token !== currentStageToken) {
                    // A newer stage has already started; this callback
                    // belongs to a stage that no longer exists.
                    return;
                }
                clearInterval(countdownInterval);
                AudioManager.stop('timerTick');
                onComplete();
            }, duration);
        }

        function transitionToNextTip() {
            tipCardElement.classList.add('exit');
            AudioManager.playSwoosh('transition', { startFreq: 900, endFreq: 1900, duration: 0.22, volume: 0.16 });

            setTimeout(() => {
                currentTipIndex++;

                // Right before the final tip of the series, cut to the
                // engagement screen, then come back and load it.
                if (currentTipIndex === tips.length - 1) {
                    runShareScreen(loadTip);
                } else {
                    loadTip();
                }
            }, 500);
        }

        /* ============ KICK EVERYTHING OFF ============ */
        document.addEventListener('DOMContentLoaded', runOpening);
