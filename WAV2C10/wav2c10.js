let wav2c10 = (function () {

    const STATE_FINISHED = 0x0;
    const STATE_DETECTED = 0x1;
    const STATE_UNDECIDED = 0x2;
    const STATE_DATA_BLOCK = 0x8;
    const STATE_NAME_BLOCK = 0x20;
    const STATE_EOF_BLOCK = 0x40;
    const STATE_BLOCK_START = 0x200;
    const STATE_SYNC_LEADER = 0x400;

    const THRESHOLD = 5;
    const THRESHOLD_SILENCE = 100;
    const MAX_TRANSITION_TIME = 57;

    const LO_HI = 1;
    const HI_LO = -1;
    const HI_LO_HI = 1;
    const LO_HI_LO = -1;

    var $audioCtx;
    var $envelope = 2;
    var $threshold = 5;     /* amplitude threshold  */
    var $lengthMultiplier = 1;
    var $state = STATE_UNDECIDED;
    var $polarity = HI_LO_HI; // default positive
    var $programBytes = [];


    /* correct envelope and denoise signal */
    function correctEnvelope(buffer) {
        for (var i = 1; i < buffer.length - 1; i++) {
            buffer[i] =
                (0.5 * buffer[i - 1] +
                    1.0 * buffer[i] +
                    2.0 * buffer[i + 1]) / 3.5;
        }
    }

    function acfilter(buffer, sampleRate) {
        var lastLevel = 0;
        var droop = Math.exp(-100 / sampleRate);
        for (var i = 0; i < buffer.length; i++) {
            lastLevel = droop * (buffer[i] - lastLevel) + lastLevel;
            buffer[i] -= lastLevel;
        }
    }

    /* make signal as loud as possible */
    function normalizeAmplitude(buffer) {
        var maximum = 0.0;
        for (i = 0; i < buffer.length; i++) {
            if (Math.abs(buffer[i]) > maximum) {
                maximum = Math.abs(buffer[i]);
            }
        }
        for (i = 0; i < buffer.length; i++) {
            buffer[i] *= 127 / maximum;
        }
    }

    function isSilence(buffer, index) {
        var silent = 0;
        while (index < buffer.length && silent < THRESHOLD_SILENCE) {
            if ((buffer[index] >= $threshold ||
                buffer[index] <= -$threshold)) return false;
            silent++; index++;
        }
        return true;
    }

    function skipSilence(buffer, index) {
        while (index < buffer.length &&
            (buffer[index] <= $threshold &&
                buffer[index] >= -$threshold)) (index)++;

        return index;
    }

    function findNextProgram(startFrame, samples) {
        var blockLen = 0;
        var blockCnt = 0;
        var nameBuffer = []

        $state = STATE_UNDECIDED;
        $programBytes = [];

        while ($state !== STATE_FINISHED) {

            const byteInfo = findByte(startFrame, samples);

            if (byteInfo === -1) {
                $state = STATE_FINISHED;
                continue;
            }

            [crossing, byte] = byteInfo;
            if (byte === undefined) { // resync with leader
                startFrame = findLeader(crossing, samples);
                if (startFrame === -1) {
                    $state = STATE_FINISHED;
                }
                $state = STATE_BLOCK_START;
                continue;
            }

            if ($state === STATE_DETECTED) {
                $programBytes.push(byte);
            } else if ($state === STATE_SYNC_LEADER) {
                var frame = findLeader(crossing, samples);
                crossing = frame;
                $state = STATE_BLOCK_START;
            } else if ($state === STATE_BLOCK_START) {
                if (byte === 0x01) {
                    $state = STATE_DATA_BLOCK;
                } else if (byte === 0x00) {
                    $state = STATE_NAME_BLOCK;
                    generateLeader();
                } else if (byte === 0xFF) {
                    $state = STATE_EOF_BLOCK;
                }
                [crossing, blockLen] = findByte(crossing, samples);
                $programBytes.push(0x55);
                $programBytes.push(0x3C);
                $programBytes.push(byte);
                $programBytes.push(blockLen);
            } else if ($state === STATE_NAME_BLOCK) {
                $programBytes.push(byte);
                nameBuffer.push(byte);
                if (blockCnt++ === blockLen) {
                    generateLeader();
                    blockCnt = 0;
                    blockLen = 0;
                    $state = STATE_SYNC_LEADER;
                }
            } else if ($state === STATE_DATA_BLOCK) {
                $programBytes.push(byte);
                if (blockCnt++ === blockLen) {
                    blockCnt = 0;
                    blockLen = 0;
                    $state = STATE_SYNC_LEADER;
                }
            } else if ($state === STATE_EOF_BLOCK) {
                $programBytes.push(byte);
                $programBytes.push(0x55);
                $state = STATE_FINISHED;
            } else if ($state === STATE_UNDECIDED) {
                if (byte === 0x55) {
                    $state = STATE_SYNC_LEADER;
                }
            }
            startFrame = crossing;
        }

        return {
            binary: getBinary(),
            name: byteArrayToString(nameBuffer.splice(0, 8))
        }
    }

    function generateLeader() {
        for (var i = 0; i < 128; i++) {
            $programBytes.push(0x55);
        }
    }

    function byteArrayToString(arr) {
        var i, str = '';
        for (i = 0; i < arr.length; i++) {
            str += '%' + ('0' + arr[i].toString(16)).slice(-2);
        }
        return decodeURIComponent(str);
    }

    function getBinary() {
        const bytes = new Uint8Array($programBytes.length);
        for (i = 0; i < bytes.length; i++) {
            bytes[i] = $programBytes[i] & 0xFF;
        }
        return bytes;
    }

    function findBit(samples, startFrame) {
        const frame = findCycle(samples, startFrame, $polarity);
        if (frame === undefined) {
            // Ran off the end of the cassette.
            return -1;
        }

        const cycleSize = frame - startFrame;

        //console.log(cycleSize * $lengthMultiplier + '[' + frame + ']');

        if (cycleSize >= MAX_TRANSITION_TIME) {
            console.warn('WARN: ' + '[' + zeroPad(frame, 10) + '] ' + cycleSize);
        }

        if (cycleSize > 18 * $lengthMultiplier && cycleSize < MAX_TRANSITION_TIME) {
            // Long cycle is "0", short cycle is "1".
            const bit = cycleSize < 32 * $lengthMultiplier;
            return [frame, bit];
        } else {
            return [frame, undefined];
        }
    }

    function findLeader(startFrame, samples) {
        var leader = 0;
        var nextByte;
        while ((nextByte = findByte(startFrame, samples)) !== -1) {
            [frame, byte] = nextByte;
            startFrame = frame;
            leader = (leader << 8) + byte;
            leader &= 0xFFFF;
            if (leader === 0x553C) {
                return frame;
            }
        }
        return -1;
    }

    function findByte(startFrame, samples) {
        var byte = 0;
        var frame = startFrame;
        for (var i = 0; i < 8; i++) {
            const bitInfo = findBit(samples, frame);
            if (bitInfo === -1) { // EOF
                return -1;
            } else {
                const [crossing, bit] = bitInfo;
                if (bit === undefined) {
                    return [crossing, undefined];
                }
                byte |= ((bit ? 1 : 0) << i);
                frame = crossing;
            }
        }
        return [frame, byte & 0xFF];
    }

    function findCrossing(samples, startFrame, direction) {
        var oldSign = samples[startFrame] > 0 ? 1 : -1;

        for (var frame = startFrame; frame < samples.length; frame++) {
            var sample = samples[frame];

            const newSign = sample > THRESHOLD ? 1 : sample < -THRESHOLD ? -1 : 0;

            if (oldSign !== newSign) {
                if (newSign === direction) {
                    // console.log('CROSSING: ' +
                    //     ((direction === 1) ? 'LO_HI' : 'HI_LO') + ' - ' +
                    //     ((frame - startFrame > 18) ? '1200' : '2400'));
                    return frame;
                }
                oldSign = newSign;
            }
        }
        return undefined;
    }

    function findCycle(samples, startFrame, direction) {
        var oldSign = 0;

        for (var frame = startFrame; frame < samples.length; frame++) {
            var sample = samples[frame];
            const newSign = sample > THRESHOLD ? 1 : sample < -THRESHOLD ? -1 : 0;

            if (oldSign === -direction && newSign === direction) {
                return frame;
            }

            if (newSign !== 0) {
                oldSign = newSign;
            }
        }
        return undefined;
    }

    function synchronize(startFrame, samples) {
        var frame1 = findCycle(samples, startFrame, HI_LO_HI); // find HI->LO->HI transition

        var direction = HI_LO;

        var pos, neg;
        var frame2 = 0;
        while (Math.max(frame1, frame2) < samples.length) {
            frame2 = findCrossing(samples, frame1, direction); // LFF55

            var is1200 = (frame2 - frame1 > 18); // true if 1200Hz

            if (direction === HI_LO && !is1200) {
                neg = 1;
            } else if (direction === LO_HI && is1200 && neg === 1) {
                console.warn('SYNC [NEG, ' + frame1 + ']');
                frame1 = findCycle(samples, frame1, LO_HI_LO);
                return [LO_HI_LO, frame1]; // negative polarity
            } else if (direction === LO_HI && !is1200) {
                pos = 1;
            } else if (direction === HI_LO && is1200 && pos === 1) {
                console.warn('SYNC [POS, ' + frame1 + ']');
                frame1 = findCycle(samples, frame1, HI_LO_HI);
                return [HI_LO_HI, frame1]; // positive polarity
            }

            if (direction === LO_HI) direction = HI_LO;
            else if (direction === HI_LO) direction = LO_HI;
            frame1 = frame2;
        }
    }

    function printWav(samples) {
        for (var i = 0; i < samples.length; i++) {
            console.log('[' + zeroPad(i, 10) + ']' + ' '.repeat((samples[i] + 150) / 10) + '*');
        }
    }

    function zeroPad(num, places) {
        var zero = places - num.toString().length + 1;
        return Array(+(zero > 0 && zero)).join("0") + num;
    }

    function convert(data) {
        $audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        return new Promise((resolve, reject) => {
            $audioCtx.decodeAudioData(data).then(async (audioBuffer) => {

                $lengthMultiplier = audioBuffer.sampleRate / 44100;

                var float32Data = audioBuffer.getChannelData(0); // Float32Array for channel 0

                //acfilter(float32Data, audioBuffer.sampleRate);
                normalizeAmplitude(float32Data);
                correctEnvelope(float32Data);

                [polarity, frame] = synchronize(0, float32Data);
                $polarity = polarity;

                var program = findNextProgram(frame, float32Data);

                console.info('[✔] Audio Decoded!');

                resolve(program);
            });
        });
    }

    return { convert };
})();
