# Acquisition Strategy for a Remote Word-Divination Performance

## Executive conclusion

A reliable, short, remote divination of an arbitrarily thought-of word cannot simultaneously have all four literal properties below:

1. the word is genuinely unrestricted;
2. the spectator communicates nothing about it;
3. no physical or digital system secretly observes it; and
4. the performer names it reliably.

This is not a limitation of the current algorithm. It follows from information conservation: to distinguish one word from roughly 1,000 plausible words, the performance needs close to ten bits of information. Those bits must come from controlling the choice, observing the choice, eliciting responses, or accepting a substantial failure rate. Presentation can conceal the channel, but it cannot remove it.

The current structural approach is therefore the wrong primary acquisition method for the stated effect. Exact length, vowel count, and consonant count leave an average of 5.4 bits unresolved in the present household dictionary. A typical word remains among dozens of alternatives. Reaching one answer then requires a conspicuous sequence of probes.

The recommended solution is a **private commitment acquisition**:

- The spectator genuinely chooses any valid word.
- They privately seal it on their own device to prevent later memory drift or changing the choice.
- The commitment action is the single concealed high-bandwidth channel.
- The performer never asks for counts, letters, positions, categories, yes/no confirmations, or a code.
- The hidden performer app receives the word ephemerally and uses the existing structural engine to choreograph a credible progressive revelation—not to discover the word.
- The complete effect lasts about three minutes, and the acquisition occupies 15–25 seconds.

This is the only general architecture that combines genuine free choice, remote operation, high reliability, and no experienced sense of interrogation. It does not literally satisfy “no information was provided”: the private commitment is the method. The honest design target is instead **“the spectator never knowingly tells the performer anything about the word.”**

If the use of a spectator device or a private commitment is unacceptable, the effect must change. The viable alternative is a constrained-choice routine using a designed set, an outcome force, and multiple outs. It can preserve the *experience* of free choice, but it cannot truthfully offer an arbitrary word.

“Magician-proof” should also be replaced with the testable term **magician-resistant**. Knowledgeable performers will correctly consider peeks, forces, pre-show work, coded responses, and multiple outs. Resistance comes from method layering, temporal separation, and occasionally using independent acquisition modes—not from pretending that one familiar method is unknowable.

## Performance requirements

The intended effect is not a version of Twenty Questions. It has a strict theatrical budget:

| Dimension | Requirement |
|---|---|
| Total duration | 3–5 minutes, including the reveal |
| Acquisition | 60–90 seconds maximum; preferably under 30 seconds |
| Perceived probes | Zero preferred; one defensible response acceptable |
| Adaptive follow-up | No more than one or two moments |
| Choice | Subjectively free; genuinely free in the recommended mode |
| Medium | Audio call and video call |
| Equipment | Spectator’s ordinary browser; no installed app |
| Reliability | Professional-performance level, with an explicit recovery path |
| Recall | Spectator should remember choosing privately and revealing nothing aloud |

The experience should be described by the spectator as: “I thought of any word, locked it so I could not change my mind, and they gradually arrived at it.” It should not be remembered as: “They asked how many letters and vowels it had.”

## The information boundary

Let the hidden word be a random variable \(W\) drawn from a vocabulary of \(N\) plausible choices. Identifying it requires approximately \(\log_2 N\) bits when choices are uniform, or the entropy \(H(W)\) when they are not. A thousand equiprobable words require almost ten bits.

A yes/no response conveys at most one bit, and usually less because branches are unbalanced or answers are noisy. Two binary responses cannot reliably distinguish more than four equally likely possibilities. A pause, selected position, number, typed string, eye movement, or click can carry more than one bit, but it is still a communication channel.

There are only four fundamental ways to complete the effect:

| Method family | Where the information comes from |
|---|---|
| Choice control | The performer reduces or determines what can be chosen |
| Secret observation | A peek, impression, assistant, camera, app, or pre-show source learns it |
| Response elicitation | The spectator’s answers, corrections, timing, gestures, or choices encode it |
| Statistical risk | The performer guesses a high-base-rate answer and accepts misses |

Classic mentalism methods are variations or combinations of these families. The psychologically based taxonomy of forcing likewise distinguishes decision forces, which influence what is selected, from outcome forces, where a choice is made but does not control the eventual outcome.[^1]

This boundary provides a useful rejection rule: any proposed “no-input” system must identify its actual channel. If no channel can be named, either the selection has been forced, the success rate has been overstated, or a hidden observer has been omitted from the description.

## What the present dictionary says

The current project contains 1,184 concepts carrying the `house` theme. Measurements below use its 1/3/5 base weights and should be treated as engineering estimates rather than human-choice norms.

The prior entropy is **9.86 bits**. Structural signatures reduce it as follows:

| Information acquired | Average residual uncertainty | Median collision group | Concepts leaving ≤2 candidates |
|---|---:|---:|---:|
| Exact length and vowel count | 5.41 bits | 79 | 1.9% |
| Counts plus vowel/consonant boundaries | 4.84 bits | 69 | 4.8% |
| Complete vowel/consonant position pattern | 2.88 bits | 7 | 29.6% |
| Counts plus first and last letters | 1.13 bits | 2 | 54.1% |
| Length plus ordered vowel sequence | 0.77 bits | 1 | 74.4% |
| Full vowel positions plus ordered vowel sequence | 0.45 bits | 1 | 85.9% |

The important result is not merely that counts are weak. It is that **the ordered identities of the vowels are far more valuable than their number**. Unfortunately, a performer cannot reliably infer that ordered sequence through ordinary video or audio without receiving a deliberate signal or secretly observing an input.

The original OMBRELLO example demonstrates the difference between weak and rich structure. Counts alone leave 81 current candidates. Exact counts plus “starts with a vowel” and “ends with a vowel” leave four: OMBRELLO, OMBRETTO, ESPRESSO, and INGRESSO. This is an unusually favorable case, not a representative guarantee.

The present `house_basic` simulation is also not a faithful simulation of the proposed performance. It applies an exact consonant count and a minimum total-vowel count, but omits exact length, internal-vowel bounds, and boundary information. It is useful for engine testing but cannot validate the acquisition hypothesis.

## Survey of method families

### Psychological forces and priming

Psychological forces preserve a strong sense of freedom when they work, and they can operate through video. Their weakness is outcome reliability. A conversational priming experiment targeting the three of diamonds increased selection well above chance, but only **17.8%** of participants selected the exact target. Number and suit features were influenced more often, yet neither made the force dependable as a standalone performance method.[^2]

Position and population-stereotype forces show the same pattern. One controlled study achieved the target selection in about **52%** of trials. Explicitly reminding participants that they were making a choice reduced effectiveness by encouraging deliberation.[^3] This is especially relevant here: emphasizing “a completely free word” may cause people to avoid the obvious household nouns on which a prior or force depends.

Salience forces can be extremely strong when the performer controls the perceptual stream. A visual riffle force influenced live selections in 98% of trials while only 9% noticed the influence.[^4] That result does not generalize to a purely thought-of word: the high success depends on controlling what is physically displayed and when.

Priming should therefore be used to shape the prior—not to acquire the exact word. It can make a small set more likely and improve recovery rates, but every psychologically forced target needs an out.

### Outcome forces and equivoque

Outcome forces are attractive because they can be deterministic. Equivoque uses semantic ambiguity and flexible interpretation so different choices converge on one outcome. Experimental work found that participants generally retained a sense of agency and failed to notice inconsistencies, even after repetition.[^5]

The limitation is structural. Equivoque works when the performer supplies a manageable set of options and controls how choices affect the outcome. It does not reveal an internally generated arbitrary word. Applying it here means changing the effect from “any word” to “a choice that feels broad inside a designed system.”

It is a strong basis for the constrained-choice alternative, not for the primary free-word mode.

### Progressive anagrams and verbal fishing

Progressive or branching anagrams identify a selection through a sequence of letter claims and spectator reactions. They are computationally related to the current next-probe engine. A NO remains useful, branches can be optimized, and statements can be phrased as impressions rather than questions.

They fail the stated spectator test when the universe is large. The participant must repeatedly confirm or reject letter information. Even if each line is artfully written, an informed observer can reconstruct the extraction process. The current median counts-only collision group of 79 would need about seven ideal binary distinctions. Rephrasing those distinctions does not change their accumulated visibility.

Progressive anagrams remain useful as a single recovery beat after the candidate set is already tiny. They should not be the main acquisition channel.

### Cold reading, pumping, and high-probability statements

Cold reading combines base rates, broadly applicable statements, interpretation, and feedback. Its psychological foundation includes the Barnum effect and the participant’s role in making general statements feel specific.[^6]

That is appropriate for personality or biographical material, but poorly matched to exact orthographic identification. “It feels manufactured” can create texture and supply a false explanatory trail; it cannot reliably distinguish COLAPASTA from dozens of structurally similar words. Cold-reading language belongs in presentation, not in the correctness-critical path.

### Muscle reading and involuntary behavior

Contact mind reading can use involuntary muscular responses when a spectator physically guides a performer toward a known target. It requires contact and a constrained physical search. It does not transfer to audio calls and loses its core signal over video.

Eye position, blinks, pupil size, and response time have been studied in concealed-information tests. Controlled experiments can classify recognition above chance, sometimes strongly, but they repeatedly present known probes under calibrated conditions. Webcam gaze measurement has substantial quality and motion constraints.[^7] Testing 26 letters repeatedly would be slow, device-dependent, and vulnerable to lighting, latency, reading strategy, aphantasia, dyslexia, countermeasures, and individual variation.

Physiological inference is a worthwhile research prototype, not a professional solution. It cannot currently support the required reliability and time budget.

### Statistical prediction and human word priors

People do not choose words uniformly. Frequency, familiarity, age of acquisition, typicality, context, and name agreement all influence lexical retrieval. Italian object-naming norms explicitly measure these variables and show that objects can attract several competing labels.[^8] A serious prior should use choice-task data rather than subtitle frequency alone: a common spoken word is not necessarily a common answer to “think of an object in your home.”

Better priors can make early statements and fallback guesses much stronger. They cannot create certainty. They are best used to rank outs, choose reveal paths, and identify categories that deserve dedicated forces.

### Peeks, impressions, pre-show, and assistants

These methods acquire the actual information. They preserve genuine choice and eliminate the entropy problem. Their weakness is methodological suspicion: knowledgeable spectators know that exact information is commonly obtained before the apparent effect, through writing, an assistant, a device, or another concealed observation.

Temporal separation is a well-established form of misdirection. Actions performed before the audience believes the trick has begun are often excluded from causal reconstruction.[^9] A private commitment can exploit this principle without a long pre-show procedure.

For remote work, a digital commitment is the only general-purpose member of this family that works on both audio and video calls without physical props.

### Digital peeks and remote apps

Commercial products already advertise remote, spectator-phone, and thought-revelation workflows. Xeno, for example, advertises remote audio/video performance and browser-based integrations; Enigma advertises an app-hidden word divination based on silent visualization.[^10] These claims demonstrate that the design territory is established, not that any proprietary implementation should be copied.

The lesson is strategic: technology can solve remote acquisition, but the theatrical challenge becomes explaining why the spectator used a device without making the device the obvious method. A custom page that exists only to receive the secret is weak. A commitment action with a genuine dramatic purpose is stronger.

### Multiple outs, one-ahead structures, and dual reality

These methods do not necessarily acquire more information; they reduce the amount required for a successful ending. Multiple outs exploit the audience’s assumption that only the revealed ending existed.[^11] Dual reality allows the participant and wider audience to understand instructions differently. One-ahead structures use previously acquired information to make the next revelation appear current.

All are valuable supporting layers. None permits reliable arbitrary-word divination from zero input. Multiple outs are particularly useful after a force or weak acquisition leaves two to four plausible targets.

## Candidate architectures and verdicts

| Architecture | Free choice | Remote | No fishing | Reliability | Duration | Verdict |
|---|---:|---:|---:|---:|---:|---|
| Exact counts plus adaptive probes | Yes | Yes | No | Medium | Too long | Reject |
| Full vowel sequence through verbal confirmation | Yes | Yes | No | Medium | Borderline | Reject |
| Conversational priming alone | No guarantee | Yes | Yes | Low | Good | Supporting layer only |
| Equivoque from a designed list | Subjectively | Yes | Mostly | High | Good | Viable alternate effect |
| Webcam gaze/pupil/reaction inference | Yes | Video mainly | Yes | Unproven | Borderline | Research prototype |
| Pure statistics/common-word guess | Yes | Yes | Yes | Low | Excellent | Out only |
| Progressive anagram from large set | Yes | Yes | No | High eventually | Too long | Recovery only |
| Pre-show/assistant | Yes | Yes | Yes in-show | High | Excellent | Strong but operationally heavy |
| Private digital commitment | Yes | Yes | Yes verbally | High | Excellent | Recommended |

## Recommended system: Sealed Thought

### Effect as experienced

A spectator thinks of any single Italian word naming a physical object. They are invited to change their mind once if the first word feels too obvious. They privately seal the final word on their own phone so that nobody—including the spectator—can later reinterpret the choice. The phone is put away. The performer guides one short visualization and progressively reveals the thought, ending with the exact word.

The spectator never says a letter, count, category, yes/no answer, or code. The performer never touches the spectator’s phone and never asks to see its screen.

### Actual architecture

The commitment page transmits the normalized word to the performer’s authenticated session. The transmission is ephemeral and single-use. The performer app immediately derives orthographic features and a reveal route. The word itself is automatically deleted at the end of the session or after a short timeout.

The current ranking engine becomes a theatrical planning engine. Given the known target, it should select a progression that looks inferential while avoiding transparent enumeration:

1. a broad, high-confidence sensory or object-class impression;
2. one structural observation that is true but not mechanically revealing;
3. a near-word or phonetic fragment when appropriate;
4. the exact written or spoken reveal.

No confirmation is required before the final reveal. Optional confirmations should concern the theatrical image, not spelling.

### Why the commitment is justified

The page is not introduced as a mind-reading tool. Its overt function is to establish an immutable commitment: the spectator cannot unconsciously change from an easy word to a nearby one after hearing the performer’s statements. That is a genuine problem in an experiment about memory and thought.

The visible page should do only three things:

- accept one non-sensitive word;
- display a clear “sealed” state and timestamp;
- offer a final local verification after the reveal.

It should not display random codes, ask secondary questions, show category lists, or require the spectator to read anything aloud. Every extra interaction gives the audience another candidate data channel.

### Privacy and ethical constraints

The page must explicitly restrict input to a non-sensitive object word. It should never invite names, passwords, addresses, medical information, or private memories. The service should store no analytics tied to the word, log no plaintext, and delete session material automatically. The performer dashboard should prevent screenshots or history where practical.

Deception about the magical method is part of the entertainment contract; deception about collecting sensitive personal data is not. The privacy design should be real, even though the transmission is secret within the performance.

## Three-minute presentation

### 0:00–0:25 — Freedom without overemphasis

> Think of one physical object—something that could exist in a home. Don’t choose for me. If the first thing feels painfully obvious, let it go and take the next one. Settle on one ordinary Italian word.

This gives a valid dictionary target and allows a change of mind, which strengthens remembered agency. It avoids repeatedly insisting that the choice is “completely free”; explicit decision framing can make choices more deliberate and resistant to useful population tendencies.[^3]

### 0:25–0:45 — Private commitment

> Before we start, lock it privately. Open the link, type the word where only you can see it, and press **Seal**. Don’t show me the screen and don’t read anything out. Put the phone face down when it says the thought is fixed.

The performer should already be looking away and should continue speaking naturally. There is no pause in which they visibly consult a device.

### 0:45–1:15 — Remove the method from the device

> Now forget the spelling for a moment. See the actual object—not the word. Give it a real place, distance, weight and temperature. I’m not going to ask you to describe any of that. I just want the thought to behave like an image rather than an answer in a quiz.

This phase gives the commitment time to recede in memory and explicitly promises no interrogation. It also supplies a plausible false model: the performer appears to read an imagined object rather than decode spelling.

### 1:15–2:15 — Progressive revelation without questions

The app supplies three target-specific beats. A generic example structure is:

> This feels functional rather than decorative. The image has a very clear outline, but the written word is less compact than the object itself. There is a repeated open sound running through it… I want to commit before you react.

These lines must be generated from curated semantic attributes and phonetic structure, not invented ad hoc by an unconstrained language model. The spectator is instructed not to confirm or deny intermediate statements.

The performer writes the final word visibly.

### 2:15–3:00 — Reveal and verification

> For the first time, say the word.

The written prediction is shown simultaneously. The spectator may then reopen the seal to verify that the original word matches. The verification page should reveal only their own locally displayed input and timestamp.

### Failure handling

Professional reliability requires defined states:

- **No transmission:** the dashboard shows a silent failure state. The performer changes the effect before making specific claims: “Keep this as an image; I’m going to send something to you instead.” A forceable prediction or non-word routine becomes the ending.
- **Unknown or misspelled word:** show the raw input plus normalized suggestions. The performer reveals phonetically or asks for the spoken word only after committing to a close fragment.
- **Multiple-word phrase:** retain the exact phrase for reveal but do not use dictionary choreography.
- **Connectivity failure:** the page must visibly seal locally, while the performer receives an unambiguous failure signal. Never let absence of data look like a valid empty result.

The recovery must be a different effect, not a sequence of emergency questions.

## Magician resistance

No single remote arbitrary-word method is literally magician-proof. A knowledgeable observer should suspect a digital peek as soon as the spectator enters the word into a browser. The design can still resist confident reconstruction.

### Temporal separation

Complete the commitment before the apparent mind-reading experiment begins. Misdirection research notes that methods performed outside the audience’s assumed effect window are less likely to enter causal reasoning.[^9]

### No visible performer retrieval

The hidden app should communicate through a glance already justified by the environment, a watch complication, audio cue, or memorized short display. The exact delivery mechanism should be selectable. Repeatedly looking at a phone immediately after sealing destroys the separation.

### False explanatory trail

The visualization phase gives a coherent alternative explanation: the performer appears to infer image qualities and only later allows spelling to emerge. False solutions can inhibit discovery of a simpler true method, although they should not be treated as invincible.[^12]

### Independent modes

A professional version should support at least two genuinely independent acquisition modes under substantially similar presentation:

1. **Commit mode:** the page supplies the word.
2. **Known-ahead mode:** pre-show, an assistant, or a controlled choice supplies the word; the page is a non-transmitting local commitment.

Using different methods across performances prevents one successful hypothesis from explaining every observation. This is more credible magician resistance than adding complexity to one digital peek.

### Do not over-prove the conditions

Repeatedly saying “the page cannot transmit,” “there is no app,” or “I never touched the phone” directs analytical attention toward exactly those possibilities. Research on the Too Perfect Theory is mixed, but it confirms that spectators generate causal explanations and that staged or technological explanations can reduce the intended experience.[^13] State the procedure once and move on.

## Constrained-choice alternative

If a spectator device is forbidden, the advertised effect must become:

> Think of one object from a large imaginative world we build together.

The performer presents four broad environments or sensory scenes and uses an outcome force to retain one. Inside that scene, a short, tested verbal-generation prompt biases a set of perhaps 8–16 high-frequency objects. The app tracks the path and prepares multiple outs. One progressive-anagram beat may resolve the final two or three.

This can be short and remote. It should not be described internally as an arbitrary-word divination. Its reliability comes from controlling the universe and covering outcomes, not from reading an unrestricted thought.

Psychological priming alone should never be the only layer. The exact target rate of 17.8% in the conversational card-force study is impressive experimentally but unusable as a professional guarantee.[^2]

## Product implications

The application should be divided into two explicit systems.

### Acquisition layer

- authenticated one-time session;
- spectator commitment page;
- ephemeral word transport;
- clear connectivity/failure status;
- no persistent plaintext logs;
- alternate known-ahead/manual target mode;
- locale-aware normalization;
- consent-safe restriction to non-sensitive words.

### Performance layer

- semantic attributes for each concept;
- phonetic and orthographic features;
- a target-aware reveal planner;
- selectable reveal styles and duration;
- recovery routing;
- a performer display requiring one glance;
- rehearsal mode that measures timing and script recall.

The existing blind ranking and probe engine should remain as a research instrument. It can quantify how much information each clue contributes and design constrained-choice routines. It should not be the correctness-critical engine in free-word performance mode.

## Validation plan

The method should be tested as a performance, not only as software.

### Participants

- at least 40 Italian-speaking lay spectators;
- at least 10 experienced magicians or mentalists as an adversarial cohort;
- both audio-only and video-call conditions;
- no repeated participant in initial evaluation.

### Primary measures

| Measure | Initial pass threshold |
|---|---:|
| Exact reveal or deliberate alternate ending | ≥95% |
| Median total duration | ≤3:30 |
| 95th-percentile duration | ≤5:00 |
| Spoken information-bearing questions | 0 |
| Median perceived freedom, 0–100 | ≥80 |
| Lay spectators naming the operative channel unaided | ≤20% |
| Magicians confidently naming the operative channel and mechanism | Exploratory; lower is better |

### Debrief questions

Ask in this order to avoid planting explanations:

1. “Describe everything that happened from your point of view.”
2. “At what moment could information have left your control?”
3. “How do you think the performer learned the word?”
4. “Did any moment feel like a question about the word?”
5. “How free did the original choice feel, from 0 to 100?”
6. Only then ask specifically about the phone, wording, timing, assistant, and prior knowledge.

Video-recording with consent will allow independent coding of pauses, glances, accidental questions, and moments when the procedure feels procedural.

### Decision gate

If lay spectators consistently identify the commitment page as the information channel, wording refinements are unlikely to fix the architecture. The next experiment should move acquisition earlier, use an ordinary action already present in the event, or adopt the constrained-choice effect. If the magician cohort identifies the class but not the operative mechanism, that is expected; literal magician-proofness is not a realistic product claim.

## Final recommendation

Do not invest further in disguising seven binary questions as seven different “perceptions.” The audience can reconstruct the aggregate extraction even if every individual line sounds natural.

Build and test the private commitment mode first. It is the only architecture that makes the selected word genuinely free, works on audio and video calls, finishes comfortably within the performance budget, and eliminates spoken fishing. Treat the commitment as the method and the structural engine as theatrical choreography.

If the commitment action itself violates the artistic premise, stop pursuing arbitrary free words. Build the constrained-choice version honestly at the design level and use outcome forces, tested priors, and multiple outs. There is no third reliable path hiding in better wording.

## Sources

[^1]: Alice Pailhès, Ronald A. Rensink, and Gustav Kuhn, “[A Psychologically Based Taxonomy of Magicians’ Forcing Techniques](https://eprints-gro.gold.ac.uk/29775/1/TAXONOMY-CONSCCOG-REVISED-Final.pdf),” *Consciousness and Cognition* 86 (2020), 103038.

[^2]: Alice Pailhès and Gustav Kuhn, “[Influencing Choices with Conversational Primes: How a Magic Trick Unconsciously Influences Card Choices](https://pmc.ncbi.nlm.nih.gov/articles/PMC7395500/),” *Proceedings of the National Academy of Sciences* 117, no. 30 (2020): 17675–17679.

[^3]: Alice Pailhès and Gustav Kuhn, “[Subtly Encouraging More Deliberate Decisions: Using a Forcing Technique and Population Stereotype to Investigate Free Will](https://pmc.ncbi.nlm.nih.gov/articles/PMC8211612/),” *Psychological Research* 85 (2021): 1380–1390.

[^4]: Jay A. Olson, Alym A. Amlani, Amir Raz, and Ronald A. Rensink, “[Influencing Choice Without Awareness](https://raz-lab.org/wp-content/uploads/2023/09/1-s2.0-S1053810015000057-main.pdf),” *Consciousness and Cognition* 37 (2015): 225–236.

[^5]: Alice Pailhès, Shringi Kumari, and Gustav Kuhn, “[The Magician’s Choice: Providing Illusory Choice and Sense of Agency with the Equivoque Forcing Technique](https://pubmed.ncbi.nlm.nih.gov/33252983/),” *Journal of Experimental Psychology: General* 150, no. 7 (2021): 1358–1372.

[^6]: Denis Dutton, “[The Cold Reading Technique](https://pubmed.ncbi.nlm.nih.gov/3360083/),” *Experientia* 44 (1988): 326–332.

[^7]: Travis L. Seymour, Christopher A. Baker, and Joshua T. Gaunt, “[Combining Blink, Pupil, and Response Time Measures in a Concealed Knowledge Test](https://pmc.ncbi.nlm.nih.gov/articles/PMC3563002/),” *Frontiers in Psychology* 3 (2013), and Sezen Lim, Tina Walber, Christoph Schaefer, and Lena Riehl, “[Webcam Eye Tracking: Study Conduction and Acceptance of Remote Tests with Gaze Analysis](https://arxiv.org/abs/2207.14380),” 2022.

[^8]: Eduardo Navarrete et al., “[Italian Norms and Naming Latencies for 357 High Quality Color Images](https://pmc.ncbi.nlm.nih.gov/articles/PMC6386297/),” *PLOS ONE* 14, no. 2 (2019).

[^9]: Gustav Kuhn, Hugo A. Caffaratti, Robert Teszka, and Ronald A. Rensink, “[A Psychologically-Based Taxonomy of Misdirection](https://pmc.ncbi.nlm.nih.gov/articles/PMC4260479/),” *Frontiers in Psychology* 5 (2014): 1392.

[^10]: Marc Kerstein, “[Xeno — Reveal a Thought](https://apps.apple.com/us/app/xeno-reveal-a-thought/id1242975358),” Apple App Store product description, accessed September 2026; Enigma of the Mind, “[Enigma for Android](https://www.enigmaofthemind.com/store/p/enigma-ios-t72sz),” product description, accessed September 2026. Product claims have not been independently verified.

[^11]: Giacomo Bigliardi, “[The Multiple Outs Method, Explained](https://www.oneahead.com/p/multiple-outs),” One Ahead, February 2025.

[^12]: Cyril Thomas and André Didierjean, “[Magicians Fix Your Mind: How Unlikely Solutions Block Obvious Ones](https://www.sciencedirect.com/science/article/pii/S0010027716301494),” *Cognition* 154 (2016): 169–173.

[^13]: Alice Pailhès et al., “[Too Perfect to Be Good? An Investigation of Magicians’ Too Perfect Theory](https://pmc.ncbi.nlm.nih.gov/articles/PMC9161811/),” *PeerJ* 10 (2022): e13449.

Additional project evidence: “Objective — Mentalism Word-Divination System,” supplied project context, sections 1–17; current `italian_words.csv` and `engine.py`, measured locally in September 2026.
