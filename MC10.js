/*
MC10, based on work by Chris Mennie
Copyright (C) 2012 Mike Tinnes [www.catalystllc.biz]

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

/*
Contributions by Greg Dionne

05/18/2017 - audio processing
05/21/2017 - video mode support
05/28/2017 - float address bus on unconnected memory (0x0020-0x007F,0x0100-0x4000)
           - properly support video colors in SG6 with restricted MC6847 CSS pin.
           - add partial support for reading keyboard strobe from 0x9000-0xbfff.
01/10/2017 - fix carry on negate instructions
02/16/2017 - use direct page address for BASIC load start address
07/08/2022 - reorg cassette dir
07/05/2022 - Add Johan Koelman's 'shogun'
06/25/2022 - add Peter/Simon's Ghostrush and Ron's S.U&K.S
06/11/2022 - patch SWI
12/30/2021 - imm store tweak
12/04/2021 - undoc opcode update
11/28/2021 - color/font tweaks
11/27/2021 - undoc opcode update
11/24/2021 - add playback finished callback
11/22/2021 - cosmetic tweak
11/22/2021 - revert to one file input control
11/20/2021 - fix button callback
11/20/2021 - add undoc opcodes; split quicktype/play; reset down/up behavior; emulate unused keyboard bits
05/11/2020 - cassette file re-org
05/04/2020 - sad music
05/02/2020 - fix audio when reset pressed
06/20/2019 - allow same file to be re-input
06/17/2019 - update README to reflect cassette emulation
06/16/2019 - add Tamer's life-ed
06/16/2019 - add quicktype directory
06/16/2019 - fix Chrome for https://goo.gl/7K7WLu
06/16/2019 - add help for .txt, .c10, .wav
06/16/2019 - add quicktype
06/13/2019 - rename audio->wav
06/12/2019 - remove in-place save/load
06/12/2019 - remove visual studio references
05/03/2019 - remove debug statement
05/03/2019 - add explanatory text
*/

function FiniteBuffer(n) {
    this._array = new Array(n);
    this.start = 0;
    this.length = 0;
    this.capacity = n;
}

FiniteBuffer.prototype.clear = function () {
    this.start = 0;
    this.length = 0;
};

FiniteBuffer.prototype.get = function (i) {
    if (i < 0 || i >= this.length)
        return undefined;
    return this._array[(this.start + i + this.capacity) % this.capacity];
};

FiniteBuffer.prototype.pull = function () {
    if (this.length == 0)
        return undefined;
    var value = this._array[this.start];
    this.start = (this.start + 1) % this.capacity;
    this.length = this.length - 1;
    return value;
};

FiniteBuffer.prototype.push = function (v) {
    if (this.length < this.capacity) {
        this._array[(this.start + this.length + this.capacity) % this.capacity] = v;
        this.length++;
    } else {
        this.start++;
        if (this.start >= this.capacity) {
            this.start = 0;
        }
        this._array[(this.start + this.length + this.capacity) % this.capacity] = v;
    }
};


var MC10 = function (opts) {
    this.opts = {
        maxRam: 0x8fff,
        preferredFrameRate: 60,
        onDebug: function () { console.debug('Debug handler not defined'); }
    };
    if (typeof opts != 'undefined') {
        var key;
        for (key in this.opts) {
            if (typeof opts[key] != 'undefined') {
                this.opts[key] = opts[key];
            }
        }
    }
    this.maxRam = this.opts.maxRam;
    this.overclock = 1; //32;
    this.clockRate = this.overclock * 890000;
    this.frameTime = Math.round(1000 / this.opts.preferredFrameRate);
    this.actualFrameRate = 1000 / this.frameTime;
    this.cpu = new MC10.MC6803(this);
    this.vdg = new MC10.MC6847(this);
    this.keyboard = new MC10.KBD(this);
    this.cassette = new MC10.Cassette(this);
    this.frameTick = this.frame.bind(this, false);
    this.lastFrameTime = 0;

    this.isDebugging = false;
    this.isStepOut = false;
    this.onDebug = this.opts.onDebug;
    this.historyBuffer = new Array();
    this.historyBuffer.push = function () {
        if (this.length >= 50) {
            this.shift();
        }
        return Array.prototype.push.apply(this, arguments);
    };
};

MC10.prototype = {
    isRunning: false,
    isDebugging: false,

    ROM: [],

    init: function() {

        this.vdg.init();
        this.cpu.init();
        this.keyboard.init();
        this.cassette.init();
    },

    reset: function () {
        this.vdg.reset();
        this.cpu.reset();
        this.keyboard.reset();
        this.cassette.reset();

        setInterval(function () {
            if (this.isDebugging && this.isRunning) {
                this.onDebug();
            }
        }.bind(this), 500)
    },

    resetDown: function () {
        this.pause();
        this.vdg.reset();
        for (var i = 0; i < 0x1800; ++i) {
            this.vdg.updateDisplay(i, this.cpu.memory[0x4000 + (i & 0xfff)]);
        }
        this.vdg.paintFrame();
    },

    resetUp: function () {
        this.run();
        this.reset();
    },

    run: function () {
        if (!this.isRunning) {
            this.isRunning = true;
            //var frameTick = this.frame.bind(this);

            requestAnimationFrame(this.frameTick);

            // this.cycleInterval = setInterval(
            //     frameTick,
            //     this.frameTime
            // );
            // this.debugger.value = "running...";
        }
    },

    pause: function () {
        if (this.isRunning) {
            //clearInterval(this.cycleInterval);
            this.isRunning = false;
        }
        this.onDebug();
    },

    toggleDebug: function () {
        this.isDebugging = !this.isDebugging;
        return this.isDebugging;
    },

    break: function () {
        this.cpu.suspend();
    },

    step: function () {
        this.frame(true);
    },

    stepOut: function () {
        this.isStepOut = true;
        this.run();
    },

    frame: function (step) {
        if (!this.isRunning && !step) return;

        requestAnimationFrame(this.frameTick);

        let now = Math.round(
            (this.opts.preferredFrameRate * Date.now()) / 1000
        );
        if (now == this.lastFrameTime) return;
        this.lastFrameTime = now;

        var cpu = this.cpu;
        var breakon = this.clockRate / this.actualFrameRate;
        var cycles = 0;
        while ((cycles < breakon)) {

            var len = this.historyBuffer.length;
            if (this.isDebugging && (len === 0 || this.historyBuffer[len - 1].diffCycle !== 0)) {
                len = this.historyBuffer.push({
                    cycle: 0,
                    diffCycle: 0,
                    pc: (this.cpu.REG_PC) & 0xffff,
                    inst: this.cpu.disassemble((this.cpu.REG_PC) & 0xffff),
                    flags: {
                        c: this.cpu.F_CARRY,
                        o: this.cpu.F_OVERFLOW,
                        z: this.cpu.F_ZERO,
                        s: this.cpu.F_SIGN,
                        i: this.cpu.F_INTERRUPT,
                        h: this.cpu.F_HALFCARRY
                    },
                    a: this.cpu.REG_A[0],
                    b: this.cpu.REG_B[0],
                    d: this.cpu.REG_D[0],
                    x: this.cpu.REG_IP,
                    s: this.cpu.REG_SP
                });
            }
            var cnt = cpu.emulate();
            if (cnt === -1) { // break signaled from the cpu
                this.isStepOut = false;
                this.pause();
                break;
            } else {
                this.cassette.advance(cnt);
                cycles += cnt;
                for (var i = 0; i < cnt; i++) {
                    this.vdg.updateAudio();
                }
            }

            if (this.isDebugging) {
                this.historyBuffer[len - 1] = {
                    ...this.historyBuffer[len - 1],
                    cycle: cnt,
                    flags: {
                        c: this.cpu.F_CARRY,
                        o: this.cpu.F_OVERFLOW,
                        z: this.cpu.F_ZERO,
                        s: this.cpu.F_SIGN,
                        i: this.cpu.F_INTERRUPT,
                        h: this.cpu.F_HALFCARRY
                    },
                    a: this.cpu.REG_A[0],
                    b: this.cpu.REG_B[0],
                    d: this.cpu.REG_D[0],
                    x: this.cpu.REG_IP,
                    s: this.cpu.REG_SP
                };
                var cycleCount = 0;
                this.historyBuffer.slice().reverse().forEach(function (val, idx) {
                    val.diffCycle = cycleCount -= val.cycle;
                });
            }

            if (step) {
                this.cpu.suspend();
            }
        }
        this.vdg.paintFrame();
    },

    // run: function () {
    //     if (!this.isRunning) {
    //         this.isRunning = true;
    //         this.cycleInterval = setInterval(function () {
    //             this.frame();
    //         }.bind(this), this.frameTime);
    //         // this.debugger.value = "running...";
    //     }
    // },

    // pause: function () {
    //     if (this.isRunning) {
    //         clearInterval(this.cycleInterval);
    //         this.isRunning = false;
    //     }
    // },

    // frame: function () {
    //     var cpu = this.cpu;
    //     var breakon = this.clockRate / this.actualFrameRate;
    //     var cycles = 0;
    //     while (cycles < breakon) {
    //         var cnt = cpu.emulate();
    //         this.cassette.advance(cnt);
    //         cycles += cnt;
    //         for (var i = 0; i < cnt; i++) {
    //             this.vdg.updateAudio();
    //         }
    //     }
    //     this.vdg.paintFrame();
    // },

    record: function (autoStop) {
        this.cassette.recordC10(autoStop);
    },

    loadDirect: function (buffer) {

        this.vdg.reset();

        var dv = new Uint8Array(buffer);

        var idx = 0;

        idx = this.readLeader(dv, idx);
        if (idx == -1) {
            return;
        }
        var fi = this.readFileName(dv, idx);
        if (fi == -1) {
            return;
        }
        idx = fi.idx;

        if (fi.fileType != 0) { //set the start and load addresses in memory
            this.cpu.memory[0x426a] = (fi.startAddress >> 8);
            this.cpu.memory[0x426b] = (fi.startAddress & 0xff);
            this.cpu.memory[0x426c] = (fi.loadAddress >> 8);
            this.cpu.memory[0x426d] = (fi.loadAddress & 0xff);
            console.debug("EXEC ADDR: " + fi.startAddress);
            this.cpu.memory[0x421F] = (fi.startAddress >> 8);
            this.cpu.memory[0x4220] = (fi.startAddress & 0xff);
        } else if (fi.fileType == 0) { //if we're loading a basic program, we need to fetch the start and load addresses
            fi.loadAddress = (this.cpu.memory[0x93] << 8) + this.cpu.memory[0x94];
        }

        idx = this.readLeader(dv, idx);
        if (idx == -1) {
            return;
        }

        var len = 0;
        while (1) {
            var dataBlock = this.readDataBlock(dv, idx, fi.loadAddress + len);
            if (dataBlock == -1) {
                return;
            }
            if (dataBlock == -2) {
                break;
            }
            len += dataBlock.len;
            idx = dataBlock.idx;
            idx = this.readLeader(dv, idx);
            if (idx == -1) {
                return;
            }
        }

        //update other basic areas if need be..
        //NOTE: totalBytes MIGHT BE OFF BY ONE
        if (fi.fileType == 0) {
            len += fi.loadAddress;
            this.cpu.memory[0x95] = len >> 8;
            this.cpu.memory[0x96] = len & 0xff;
        }

        idx = this.readEOF(dv, idx);
        if (idx == -1) {
            return;
        }
    },

    readEOF: function (dv, idx) {
        var b = dv[idx++];
        if (b != 0x3c) {
            console.debug("invalid cassette file");
            return -1;
        }

        b = dv[idx++];
        if (b != 0xff) {
            console.debug("invalid cassette file");
            return -1;
        }
        b = dv[idx++];
        if (b != 0x00) {
            console.debug("invalid cassette file");
            return -1;
        }
        b = dv[idx++];
        if (b != 0xff) {
            console.debug("invalid cassette file");
            return -1;
        }

        return idx;
    },

    readLeader: function (dv, idx) {
        var b = 0x55;
        while (idx < dv.buffer.byteLength && b == 0x55) {
            var b = dv[idx++];
        }
        return idx - 1;
    },

    readDataBlock: function (dv, idx, loadAddress) {
        var b = dv[idx++];
        if (b != 0x3c) {
            console.debug("invalid cassette file");
            return -1;
        }
        var checksum = 0;

        b = dv[idx++];
        if (b == 0xff) { // EOF
            return -2;
        }
        if (b != 0x01) {
            console.debug("invalid cassette file");
            return -1;
        }
        checksum += b;

        var len = dv[idx++];
        checksum += len;
        for (var i = 0; i < len; i++) {
            b = dv[idx++];
            this.cpu.memory[loadAddress++] = b;
            checksum += b;
        }

        b = dv[idx++];
        if (b != (checksum & 0xff)) {
            console.debug("invalid cassette file");
            return -1;
        }
        return { idx: idx, len: len };
    },

    readFileName: function (dv, idx) {
        var b = dv[idx++];
        if (b != 0x3c) {
            console.debug("invalid cassette file");
            return -1;
        }
        if (dv[idx++] != 0x00) {
            console.debug("invalid cassette file");
            return -1;
        }
        if (dv[idx++] != 0x0f) {
            console.debug("invalid cassette file");
            return -1;
        }
        var checksum = 0;

        var fname = "";
        for (var i = 0; i < 8; i++) {
            b = dv[idx++];
            fname += String.fromCharCode(b);
            checksum += b;
        }

        var filetype = dv[idx++];
        checksum += filetype;

        var datatype = dv[idx++];
        checksum += datatype;

        var gapflag = dv[idx++];
        checksum += gapflag;

        var a1 = dv[idx++];
        var a2 = dv[idx++];
        checksum += a1;
        checksum += a2;
        var startAddress = (a1 << 8) + a2;

        a1 = dv[idx++];
        a2 = dv[idx++];
        checksum += a1;
        checksum += a2;
        var loadAddress = (a1 << 8) + a2;

        checksum += 0x0f;

        b = dv[idx++];
        if (b != (checksum & 0xff)) {
            console.debug("invalid cassette file");
            return -1;
        }
        return {
            idx: idx,
            fileType: filetype,
            dataType: datatype,
            gapFlag: gapflag,
            startAddress: startAddress,
            loadAddress: loadAddress,
            fileName: fname
        };
    }
}

MC10.MC6803 = function (mc10) {
    this.mc10 = mc10;

    this.isSuspended = false;

    this.idx = 0;

    // Addressing modes
    this.DIRECT = 1;
    this.INDEX = 2;
    this.EXTENDED = 3;
    this.RELATIVE = 4;
    this.IMMEDIATE = 5;
    this.INHERENT = 6;

    this.INT_NONE = 0; // No interrupt required
    this.INT_IRQ = 1; // Standard IRQ interrupt
    this.INT_NMI = 2; // NMI interrupt
    this.WAI_ = 8; // set when WAI is waiting for an interrupt
    this.SLP = 0x10;
    this.IRQ_LINE = 0; // IRQ line number
    this.TIN_LINE = 1; // P20/Tin Input Capture line (eddge sense)
    this.CLEAR_LINE = 0; // clear (a fired, held or pulsed) line
    this.ASSERT_LINE = 1; // assert an interrupt immediately
    this.HOLD_LINE = 2; // hold interrupt line until enable is true
    this.PULSE_LINE = 3; // pulse interrupt line for one instruction

    this.TCSR_OLVL = 0x01;
    this.TCSR_IEDG = 0x02;
    this.TCSR_ETOI = 0x04;
    this.TCSR_EOCI = 0x08;
    this.TCSR_EICI = 0x10;
    this.TCSR_TOF = 0x20;
    this.TCSR_OCF = 0x40;
    this.TCSR_ICF = 0x80;

    this.optable = null;
    this.cycleCount = null;

    this.vdg = null;
    this.memoryBuffer = null;
    this.memory = null;
    this.port1Buffer = null;
    this.port1 = null;
    this.port2Buffer = null;
    this.port2 = null;
    this.memmode = null;
    this.printBuffer = null;
    this.irqState = null;
    this.waiState = null;
    this.nmiState = null;
    this.extraCycles = null;
    this.irq2 = null;
    this.pendingTCSR = null;

    this.F_CARRY = null;
    this.F_OVERFLOW = null;
    this.F_ZERO = null;
    this.F_SIGN = null;
    this.F_INTERRUPT = null;
    this.F_HALFCARRY = null;

    this.REG_ACC = null; // Accumulator
    this.REG_A = null;
    this.REG_B = null;
    this.REG_D = null;
    this.REG_SP = null; // Stack pointer
    this.REG_IP = null; // INDEX pointer
    this.REG_PC = null; // Program counter

    //this.clearTOF = false;
    //this.clearOCF = false;

    //this.init();
};

MC10.MC6803.prototype = {

    init: function () {
        this.memoryBuffer = new ArrayBuffer(0xC000);
        this.accumBuffer = new ArrayBuffer(0x02);
        this.memory = new Uint8Array(this.memoryBuffer);
        this.port1Buffer = new ArrayBuffer(8);
        this.port1 = new Uint8Array(this.port1Buffer);
        this.port2Buffer = new ArrayBuffer(8);
        this.port2 = new Uint8Array(this.port2Buffer);
        this.cycleCount = 0;
        this.printBuffer = new Array();
        this.irqState = new Array();
        this.waiState = 0;
        this.nmiState = 0;
        this.extraCycles = 0;
        this.irq2 = 0;
        this.pendingTCSR = 0;

        this.REG_ACC = new Uint8Array(this.accumBuffer);
        this.REG_D = new Uint16Array(this.accumBuffer);
        this.REG_B = this.REG_ACC.subarray(0, 1);
        this.REG_A = this.REG_ACC.subarray(1, 2);

        for (var i = 0; i < 0xC000; i++) {
            this.memory[i] = 0x00;
        }
        for (var i = 0; i < 8; i++) {
            this.port1[i] = 0xff;
            this.port2[i] = 0xff;
        }

        this.irqState[this.IRQ_LINE] = 0;
        this.irqState[this.TIN_LINE] = 0;

        this.F_CARRY = 0;
        this.F_OVERFLOW = 0;
        this.F_ZERO = 0;
        this.F_SIGN = 0;
        this.F_INTERRUPT = 0;
        this.F_HALFCARRY = 0;

        this.REG_D[0] = 0;
        this.REG_SP = 0;
        this.REG_IP = 0;

        this.inittable();

        this.reset();
    },

    reset: function () {
        this.REG_PC = (this.fetchMemory(0xfffe) << 8) + this.fetchMemory(0xffff);

        this.SEI(); // IRQ disabled

        this.memory[0x0b] = 0xff; // output compare register defaults
        this.memory[0x0c] = 0xff;
        this.memory[0x11] = 0x20; // transmit control status registers

        this.waiState = 0;
        this.nmiState = 0;
        this.irqState[this.IRQ_LINE] = 0;
        this.irqState[this.TIN_LINE] = 0;
        this.irq2 = 0;
        this.pendingTCSR = 0;
        this.cycleCount = 0;

        this.isSuspended = false;
    },

    suspend: function () {
        this.isSuspended = true;
    },

    emulate: function () {
        if (this.isSuspended) {
            this.isSuspended = false;
            return -1; // signal break
        }
        var lastpc = this.REG_PC;

        if ((this.waiState & this.WAI_) != 0) {
            console.debug("IN WAI");
            this.cycleCount = (this.cycleCount + 1) & 0xffff;
            this.checkTimer();
            return 1;
        }

        //      if (this.REG_PC>=0x60B6 && this.REG_PC<=0xE000 && this.mc10.debugger.value == "running...") {
        //          this.mc10.debugger.value = 
        //              this.lastValid6 + "\n" + 
        //              this.lastValid5 + "\n" + 
        //              this.lastValid4 + "\n" + 
        //              this.lastValid3 + "\n" + 
        //              this.lastValid2 + "\n" + 
        //              this.lastValid1 + "\n";
        //      } else {
        //          this.lastValid6 = this.lastValid5;
        //          this.lastValid5 = this.lastValid4;
        //          this.lastValid4 = this.lastValid3;
        //          this.lastValid3 = this.lastValid2;
        //          this.lastValid2 = this.lastValid1;
        //          this.lastValid1 = this.disassemble(this.REG_PC);
        //      }

        var opcode = this.fetchOpCode();

        if (this.mc10.cassette.patchROM) {
            if (lastpc == 0xff22) {
                this.F_CARRY = this.mc10.cassette.getC10bit();
                opcode = 0x39;
            } else if (lastpc == 0xfdcf) {
                this.mc10.cassette.stop();
            } else if (lastpc > 0xff2c && lastpc <= 0xff98) {
                opcode = 0x39;
            } else if (lastpc == 0xfd03 && this.mc10.cassette.recording) {
                this.mc10.cassette.recordC10byte(this.REG_A);
                opcode = 0x39;
            } else if (lastpc == 0xfc8a && this.mc10.cassette.recording) {
                this.mc10.cassette.saveRecord();
                opcode = 0x39;
            }
        }

        if (this.mc10.keyboard.patchROM && lastpc == 0xf86c) {
            this.REG_A[0] = this.mc10.keyboard.quickread();
            this.TSTA();
            opcode = 0x21;
        }

        if (opcode in this.optable) {
            var cycles = this.optable[opcode]();

            for (var i = 0; i < cycles; i++) {
                this.cycleCount = (this.cycleCount + 1) & 0xffff;
                this.checkTimer();
            }
            this.cycleCount += this.extraCycles;
            this.extraCycles = 0;

            return cycles;
        }
        //this.checkIRQLines();

        console.debug("unknown opcode: " + opcode);
    },

    checkTimer: function () {
        // TODO: input capture interrupt

        /*
         * Output compare
         */
        if (this.cycleCount == (this.memory[0x0b] << 8) + (this.memory[0x0c] & 0xff)) {
            this.memory[0x08] |= this.TCSR_OCF; // set OCF (output compare flag)
            this.pendingTCSR |= this.TCSR_OCF;
            this.modifiedTCSR();
            if (this.F_INTERRUPT == 0 && ((this.memory[0x08] & this.TCSR_EOCI) != 0)) {
                this.takeOCI();
            }
        }
        /*
         * Timer overflow
         */
        if (this.cycleCount == 0xffff) {
            this.memory[0x08] |= this.TCSR_TOF; // set TOF (timer overflow flag)
            this.pendingTCSR |= this.TCSR_TOF;
            this.modifiedTCSR();
            if (this.F_INTERRUPT == 0 && ((this.memory[0x08] & this.TCSR_ETOI) != 0)) {
                this.takeTOI();
            }
        }
    },

    interrupt: function (vector) {
        if ((this.waiState & (this.WAI_ | this.SLP)) != 0) {
            if ((this.waiState & this.WAI_) != 0) {
                this.extraCycles += 4;
            }
            this.waiState &= ~(this.WAI_ | this.SLP);
        } else {
            this.pushStack16(this.REG_PC);
            this.pushStack16(this.REG_IP);
            this.pushStack(this.REG_A[0]);
            this.pushStack(this.REG_B[0]);
            this.pushStack(this.flagsToVariable());
            this.extraCycles += 12;
        }
        this.SEI();

        this.REG_PC = vector;
        this.REG_PC &= 0xffff;
    },

    //checkIRQLines: function () {
    //    if (this.F_INTERRUPT == 0) {
    //        if (this.irqState[this.IRQ_LINE] != this.CLEAR_LINE) {
    //            this.interrupt(0xfff8);
    //        } else {
    //            this.checkIRQ2();
    //        }
    //    }
    //},

    //checkIRQ2: function () {
    //    //if ((this.irq2 & this.TCSR_ICF) != 0) {
    //    //    this.takeICI();
    //    //} else if ((this.irq2 & this.TCSR_OCF) != 0) {
    //    //    this.takeOCI();
    //    //} else if ((this.irq2 & this.TCSR_TOF) != 0) {
    //    //    this.takeTOI();
    //    //}
    //},

    takeICI: function () {
        this.interrupt(0x4209);
    },

    takeOCI: function () {
        this.interrupt(0x4206);
    },

    takeTOI: function () {
        this.interrupt(0x4203);
    },

    takeSCI: function () {
        this.interrupt(0x4200);
    },

    takeTRAP: function () {
        this.interrupt(0xF72E);
    },

    modifiedTCSR: function () {
        //this.irq2 = (this.memory[0x08] & (this.memory[0x08] << 3)) & (this.TCSR_ICF | this.TCSR_OCF | this.TCSR_TOF);
        this.irq2 = (this.memory[0x08] & (this.TCSR_ICF | this.TCSR_OCF | this.TCSR_TOF));
    },

    inittable: function () {
        var self = this;

        this.optable = {};

        //ABA
        this.optable[0x1b] = function () { self.memmode = self.INHERENT; self.ABA(); return 2; };

        //ABX
        this.optable[0x3a] = function () { self.memmode = self.INHERENT; self.ABX(); return 3 };

        //ADCA
        this.optable[0x89] = function () { self.memmode = self.IMMEDIATE; self.ADCA(); return 2; };
        this.optable[0x99] = function () { self.memmode = self.DIRECT; self.ADCA(); return 3; };
        this.optable[0xa9] = function () { self.memmode = self.INDEX; self.ADCA(); return 4; };
        this.optable[0xb9] = function () { self.memmode = self.EXTENDED; self.ADCA(); return 4; };

        //ADCB 
        this.optable[0xc9] = function () { self.memmode = self.IMMEDIATE; self.ADCB(); return 2; };
        this.optable[0xd9] = function () { self.memmode = self.DIRECT; self.ADCB(); return 3; };
        this.optable[0xe9] = function () { self.memmode = self.INDEX; self.ADCB(); return 4; };
        this.optable[0xf9] = function () { self.memmode = self.EXTENDED; self.ADCB(); return 4; };

        //ADDA 
        this.optable[0x8b] = function () { self.memmode = self.IMMEDIATE; self.ADDA(); return 2; };
        this.optable[0x9b] = function () { self.memmode = self.DIRECT; self.ADDA(); return 3; };
        this.optable[0xab] = function () { self.memmode = self.INDEX; self.ADDA(); return 4; };
        this.optable[0xbb] = function () { self.memmode = self.EXTENDED; self.ADDA(); return 4; };

        //ADDB 
        this.optable[0xcb] = function () { self.memmode = self.IMMEDIATE; self.ADDB(); return 2; };
        this.optable[0xdb] = function () { self.memmode = self.DIRECT; self.ADDB(); return 3; };
        this.optable[0xeb] = function () { self.memmode = self.INDEX; self.ADDB(); return 4; };
        this.optable[0xfb] = function () { self.memmode = self.EXTENDED; self.ADDB(); return 4; };

        //ADDD 
        this.optable[0xc3] = function () { self.memmode = self.IMMEDIATE; self.ADDD(); return 4; };
        this.optable[0xd3] = function () { self.memmode = self.DIRECT; self.ADDD(); return 5; };
        this.optable[0xe3] = function () { self.memmode = self.INDEX; self.ADDD(); return 6; };
        this.optable[0xf3] = function () { self.memmode = self.EXTENDED; self.ADDD(); return 6; };

        //ANDA 
        this.optable[0x84] = function () { self.memmode = self.IMMEDIATE; self.ANDA(); return 2; };
        this.optable[0x94] = function () { self.memmode = self.DIRECT; self.ANDA(); return 3; };
        this.optable[0xa4] = function () { self.memmode = self.INDEX; self.ANDA(); return 4; };
        this.optable[0xb4] = function () { self.memmode = self.EXTENDED; self.ANDA(); return 4; };

        //ANDB 
        this.optable[0xc4] = function () { self.memmode = self.IMMEDIATE; self.ANDB(); return 2; };
        this.optable[0xd4] = function () { self.memmode = self.DIRECT; self.ANDB(); return 3; };
        this.optable[0xe4] = function () { self.memmode = self.INDEX; self.ANDB(); return 4; };
        this.optable[0xf4] = function () { self.memmode = self.EXTENDED; self.ANDB(); return 4; };

        //ASL 
        this.optable[0x68] = function () { self.memmode = self.INDEX; self.ASL(); return 6; };
        this.optable[0x78] = function () { self.memmode = self.EXTENDED; self.ASL(); return 6; };

        //ASLA 
        this.optable[0x48] = function () { self.memmode = self.INHERENT; self.ASLA(); return 2; };

        //ASLB 
        this.optable[0x58] = function () { self.memmode = self.INHERENT; self.ASLB(); return 2; };

        //ASLD 
        this.optable[0x05] = function () { self.memmode = self.INHERENT; self.ASLD(); return 3; };

        //ASR 
        this.optable[0x67] = function () { self.memmode = self.INDEX; self.ASR(); return 6; };
        this.optable[0x77] = function () { self.memmode = self.EXTENDED; self.ASR(); return 6; };

        //ASRA 
        this.optable[0x47] = function () { self.memmode = self.INHERENT; self.ASRA(); return 2; };

        //ASRB 
        this.optable[0x57] = function () { self.memmode = self.INHERENT; self.ASRB(); return 2; };

        //BRA 
        this.optable[0x20] = function () { self.memmode = self.RELATIVE; self.BRA(); return 3; };

        //BRN 
        this.optable[0x21] = function () { self.memmode = self.RELATIVE; self.BRN(); return 3; };

        //BCC 
        this.optable[0x24] = function () { self.memmode = self.RELATIVE; self.BCC(); return 3; };

        //BCS 
        this.optable[0x25] = function () { self.memmode = self.RELATIVE; self.BCS(); return 3; };

        //BEQ	
        this.optable[0x27] = function () { self.memmode = self.RELATIVE; self.BEQ(); return 3; };

        //BGE	
        this.optable[0x2c] = function () { self.memmode = self.RELATIVE; self.BGE(); return 3; };

        //BGT	
        this.optable[0x2e] = function () { self.memmode = self.RELATIVE; self.BGT(); return 3; };

        //BHI	
        this.optable[0x22] = function () { self.memmode = self.RELATIVE; self.BHI(); return 3; };

        //BLE	
        this.optable[0x2f] = function () { self.memmode = self.RELATIVE; self.BLE(); return 3; };

        //BLS	
        this.optable[0x23] = function () { self.memmode = self.RELATIVE; self.BLS(); return 3; };

        //BLT	
        this.optable[0x2d] = function () { self.memmode = self.RELATIVE; self.BLT(); return 3; };

        //BMI	
        this.optable[0x2b] = function () { self.memmode = self.RELATIVE; self.BMI(); return 3; };

        //BNE	
        this.optable[0x26] = function () { self.memmode = self.RELATIVE; self.BNE(); return 3; };

        //BVC	
        this.optable[0x28] = function () { self.memmode = self.RELATIVE; self.BVC(); return 3; };

        //BVS	
        this.optable[0x29] = function () { self.memmode = self.RELATIVE; self.BVS(); return 3; };

        //BPL	
        this.optable[0x2a] = function () { self.memmode = self.RELATIVE; self.BPL(); return 3; };

        //BSR	
        this.optable[0x8d] = function () { self.memmode = self.RELATIVE; self.BSR(); return 6; };

        //BITA	
        this.optable[0x85] = function () { self.memmode = self.IMMEDIATE; self.BITA(); return 2; };
        this.optable[0x95] = function () { self.memmode = self.DIRECT; self.BITA(); return 3; };
        this.optable[0xa5] = function () { self.memmode = self.INDEX; self.BITA(); return 4; };
        this.optable[0xb5] = function () { self.memmode = self.EXTENDED; self.BITA(); return 4; };

        //BITB	
        this.optable[0xc5] = function () { self.memmode = self.IMMEDIATE; self.BITB(); return 2; };
        this.optable[0xd5] = function () { self.memmode = self.DIRECT; self.BITB(); return 3; };
        this.optable[0xe5] = function () { self.memmode = self.INDEX; self.BITB(); return 4; };
        this.optable[0xf5] = function () { self.memmode = self.EXTENDED; self.BITB(); return 4; };

        //CBA	
        this.optable[0x11] = function () { self.memmode = self.INHERENT; self.CBA(); return 2; };

        //CLC	
        this.optable[0x0c] = function () { self.memmode = self.INHERENT; self.CLC(); return 2; };

        //CLI	
        this.optable[0x0e] = function () { self.memmode = self.INHERENT; self.CLI(); return 2; };

        //CLR	
        this.optable[0x6f] = function () { self.memmode = self.INDEX; self.CLR(); return 6; };
        this.optable[0x7f] = function () { self.memmode = self.EXTENDED; self.CLR(); return 6; };

        //CLRA	
        this.optable[0x4f] = function () { self.memmode = self.INHERENT; self.CLRA(); return 2; };

        //CLRB	
        this.optable[0x5f] = function () { self.memmode = self.INHERENT; self.CLRB(); return 2; };

        //CLV	
        this.optable[0x0a] = function () { self.memmode = self.INHERENT; self.CLV(); return 2; };

        //CMPA	
        this.optable[0x81] = function () { self.memmode = self.IMMEDIATE; self.CMPA(); return 2; };
        this.optable[0x91] = function () { self.memmode = self.DIRECT; self.CMPA(); return 3; };
        this.optable[0xa1] = function () { self.memmode = self.INDEX; self.CMPA(); return 4; };
        this.optable[0xb1] = function () { self.memmode = self.EXTENDED; self.CMPA(); return 4; };

        //CMPB	
        this.optable[0xc1] = function () { self.memmode = self.IMMEDIATE; self.CMPB(); return 2; };
        this.optable[0xd1] = function () { self.memmode = self.DIRECT; self.CMPB(); return 3; };
        this.optable[0xe1] = function () { self.memmode = self.INDEX; self.CMPB(); return 4; };
        this.optable[0xf1] = function () { self.memmode = self.EXTENDED; self.CMPB(); return 4; };

        //COM	
        this.optable[0x63] = function () { self.memmode = self.INDEX; self.COM(); return 6; };
        this.optable[0x73] = function () { self.memmode = self.EXTENDED; self.COM(); return 6; };

        //COMA	
        this.optable[0x43] = function () { self.memmode = self.INHERENT; self.COMA(); return 2; };

        //COMB	
        this.optable[0x53] = function () { self.memmode = self.INHERENT; self.COMB(); return 2; };

        //CPX	
        this.optable[0x8c] = function () { self.memmode = self.IMMEDIATE; self.CPX(); return 4; };
        this.optable[0x9c] = function () { self.memmode = self.DIRECT; self.CPX(); return 5; };
        this.optable[0xac] = function () { self.memmode = self.INDEX; self.CPX(); return 6; };
        this.optable[0xbc] = function () { self.memmode = self.EXTENDED; self.CPX(); return 6; };

        //DAA	
        this.optable[0x19] = function () { self.memmode = self.INHERENT; self.DAA(); return 2; };

        //DEC	
        this.optable[0x6a] = function () { self.memmode = self.INDEX; self.DEC(); return 6; };
        this.optable[0x7a] = function () { self.memmode = self.EXTENDED; self.DEC(); return 6; };

        //DECA	
        this.optable[0x4a] = function () { self.memmode = self.INHERENT; self.DECA(); return 2; };

        //DECB	
        this.optable[0x5a] = function () { self.memmode = self.INHERENT; self.DECB(); return 2; };

        //DES	
        this.optable[0x34] = function () { self.memmode = self.INHERENT; self.DES(); return 3; };

        //DEX	
        this.optable[0x09] = function () { self.memmode = self.INHERENT; self.DEX(); return 3; };

        //EORA	
        this.optable[0x88] = function () { self.memmode = self.IMMEDIATE; self.EORA(); return 2; };
        this.optable[0x98] = function () { self.memmode = self.DIRECT; self.EORA(); return 3; };
        this.optable[0xa8] = function () { self.memmode = self.INDEX; self.EORA(); return 4; };
        this.optable[0xb8] = function () { self.memmode = self.EXTENDED; self.EORA(); return 4; };

        //EORB	
        this.optable[0xc8] = function () { self.memmode = self.IMMEDIATE; self.EORB(); return 2; };
        this.optable[0xd8] = function () { self.memmode = self.DIRECT; self.EORB(); return 3; };
        this.optable[0xe8] = function () { self.memmode = self.INDEX; self.EORB(); return 4; };
        this.optable[0xf8] = function () { self.memmode = self.EXTENDED; self.EORB(); return 4; };

        //INC	
        this.optable[0x6c] = function () { self.memmode = self.INDEX; self.INC(); return 6; };
        this.optable[0x7c] = function () { self.memmode = self.EXTENDED; self.INC(); return 6; };

        //INCA	
        this.optable[0x4c] = function () { self.memmode = self.INHERENT; self.INCA(); return 2; };

        //INCB	
        this.optable[0x5c] = function () { self.memmode = self.INHERENT; self.INCB(); return 2; };

        //INS	
        this.optable[0x31] = function () { self.memmode = self.INHERENT; self.INS(); return 3; };

        //INX	
        this.optable[0x08] = function () { self.memmode = self.INHERENT; self.INX(); return 3; };

        //JMP	
        this.optable[0x6e] = function () { self.memmode = self.INDEX; self.JMP(); return 3; };
        this.optable[0x7e] = function () { self.memmode = self.EXTENDED; self.JMP(); return 3; };

        //JSR	
        this.optable[0x9d] = function () { self.memmode = self.DIRECT; self.JSR(); return 5; };
        this.optable[0xad] = function () { self.memmode = self.INDEX; self.JSR(); return 6; };
        this.optable[0xbd] = function () { self.memmode = self.EXTENDED; self.JSR(); return 6; };

        //LDAA	
        this.optable[0x86] = function () { self.memmode = self.IMMEDIATE; self.LDAA(); return 2; };
        this.optable[0x96] = function () { self.memmode = self.DIRECT; self.LDAA(); return 3; };
        this.optable[0xa6] = function () { self.memmode = self.INDEX; self.LDAA(); return 4; };
        this.optable[0xb6] = function () { self.memmode = self.EXTENDED; self.LDAA(); return 4; };

        //LDAB	
        this.optable[0xc6] = function () { self.memmode = self.IMMEDIATE; self.LDAB(); return 2; };
        this.optable[0xd6] = function () { self.memmode = self.DIRECT; self.LDAB(); return 3; };
        this.optable[0xe6] = function () { self.memmode = self.INDEX; self.LDAB(); return 4; };
        this.optable[0xf6] = function () { self.memmode = self.EXTENDED; self.LDAB(); return 4; };

        //LDD	
        this.optable[0xcc] = function () { self.memmode = self.IMMEDIATE; self.LDD(); return 3; };
        this.optable[0xdc] = function () { self.memmode = self.DIRECT; self.LDD(); return 4; };
        this.optable[0xec] = function () { self.memmode = self.INDEX; self.LDD(); return 5; };
        this.optable[0xfc] = function () { self.memmode = self.EXTENDED; self.LDD(); return 5; };

        //LDS	
        this.optable[0x8e] = function () { self.memmode = self.IMMEDIATE; self.LDS(); return 3; };
        this.optable[0x9e] = function () { self.memmode = self.DIRECT; self.LDS(); return 4; };
        this.optable[0xae] = function () { self.memmode = self.INDEX; self.LDS(); return 5; };
        this.optable[0xbe] = function () { self.memmode = self.EXTENDED; self.LDS(); return 5; };

        //LDX	
        this.optable[0xce] = function () { self.memmode = self.IMMEDIATE; self.LDX(); return 3; };
        this.optable[0xde] = function () { self.memmode = self.DIRECT; self.LDX(); return 4; };
        this.optable[0xee] = function () { self.memmode = self.INDEX; self.LDX(); return 5; };
        this.optable[0xfe] = function () { self.memmode = self.EXTENDED; self.LDX(); return 5; };

        //LSR	
        this.optable[0x64] = function () { self.memmode = self.INDEX; self.LSR(); return 6; };
        this.optable[0x74] = function () { self.memmode = self.EXTENDED; self.LSR(); return 6; };

        //LSRA	
        this.optable[0x44] = function () { self.memmode = self.INHERENT; self.LSRA(); return 2; };

        //LSRB	
        this.optable[0x54] = function () { self.memmode = self.INHERENT; self.LSRB(); return 2; };

        //LSRD	
        this.optable[0x04] = function () { self.memmode = self.INHERENT; self.LSRD(); return 3; };

        //MUL	
        this.optable[0x3d] = function () { self.memmode = self.INHERENT; self.MUL(); return 10; };

        //NEG	
        this.optable[0x60] = function () { self.memmode = self.INDEX; self.NEG(); return 6; };
        this.optable[0x70] = function () { self.memmode = self.EXTENDED; self.NEG(); return 6; };

        //NEGA	
        this.optable[0x40] = function () { self.memmode = self.INHERENT; self.NEGA(); return 2; };

        //NEGB	
        this.optable[0x50] = function () { self.memmode = self.INHERENT; self.NEGB(); return 2; };

        //NGC	
        this.optable[0x62] = function () { self.memmode = self.INDEX; self.NGC(); return 6; };
        this.optable[0x72] = function () { self.memmode = self.EXTENDED; self.NGC(); return 6; };

        //NGCA	
        this.optable[0x42] = function () { self.memmode = self.INHERENT; self.NGCA(); return 2; };

        //NGCB	
        this.optable[0x52] = function () { self.memmode = self.INHERENT; self.NGCB(); return 2; };

        //NOP	
        this.optable[0x01] = function () { self.memmode = self.INHERENT; self.NOP(); return 2; };

        //ORAA	
        this.optable[0x8a] = function () { self.memmode = self.IMMEDIATE; self.ORAA(); return 2; };
        this.optable[0x9a] = function () { self.memmode = self.DIRECT; self.ORAA(); return 3; };
        this.optable[0xaa] = function () { self.memmode = self.INDEX; self.ORAA(); return 4; };
        this.optable[0xba] = function () { self.memmode = self.EXTENDED; self.ORAA(); return 4; };

        //ORAB	
        this.optable[0xca] = function () { self.memmode = self.IMMEDIATE; self.ORAB(); return 2; };
        this.optable[0xda] = function () { self.memmode = self.DIRECT; self.ORAB(); return 3; };
        this.optable[0xea] = function () { self.memmode = self.INDEX; self.ORAB(); return 4; };
        this.optable[0xfa] = function () { self.memmode = self.EXTENDED; self.ORAB(); return 4; };

        //PSHA	
        this.optable[0x36] = function () { self.memmode = self.INHERENT; self.PSHA(); return 3; };

        //PSHB	
        this.optable[0x37] = function () { self.memmode = self.INHERENT; self.PSHB(); return 3; };

        //PSHX	
        this.optable[0x3c] = function () { self.memmode = self.INHERENT; self.PSHX(); return 4; };

        //PULA	
        this.optable[0x32] = function () { self.memmode = self.INHERENT; self.PULA(); return 4; };

        //PULB	
        this.optable[0x33] = function () { self.memmode = self.INHERENT; self.PULB(); return 4; };

        //PULX	
        this.optable[0x38] = function () { self.memmode = self.INHERENT; self.PULX(); return 5; };

        //ROL	
        this.optable[0x69] = function () { self.memmode = self.INDEX; self.ROL(); return 6; };
        this.optable[0x79] = function () { self.memmode = self.EXTENDED; self.ROL(); return 6; };

        //ROLA	
        this.optable[0x49] = function () { self.memmode = self.INHERENT; self.ROLA(); return 2; };

        //ROLB	
        this.optable[0x59] = function () { self.memmode = self.INHERENT; self.ROLB(); return 2; };

        //ROR	
        this.optable[0x66] = function () { self.memmode = self.INDEX; self.ROR(); return 6; };
        this.optable[0x76] = function () { self.memmode = self.EXTENDED; self.ROR(); return 6; };

        //RORA	
        this.optable[0x46] = function () { self.memmode = self.INHERENT; self.RORA(); return 2; };

        //RORB	
        this.optable[0x56] = function () { self.memmode = self.INHERENT; self.RORB(); return 2; };

        //RTI	
        this.optable[0x3b] = function () { self.memmode = self.INHERENT; self.RTI(); return 10; };

        //RTS
        this.optable[0x39] = function () { self.memmode = self.INHERENT; self.RTS(); return 5; };

        //SBA
        this.optable[0x10] = function () { self.memmode = self.INHERENT; self.SBA(); return 2; };

        //SBCA
        this.optable[0x82] = function () { self.memmode = self.IMMEDIATE; self.SBCA(); return 2; };
        this.optable[0x92] = function () { self.memmode = self.DIRECT; self.SBCA(); return 3; };
        this.optable[0xa2] = function () { self.memmode = self.INDEX; self.SBCA(); return 4; };
        this.optable[0xb2] = function () { self.memmode = self.EXTENDED; self.SBCA(); return 4; };

        //SBCB
        this.optable[0xc2] = function () { self.memmode = self.IMMEDIATE; self.SBCB(); return 2; };
        this.optable[0xd2] = function () { self.memmode = self.DIRECT; self.SBCB(); return 3; };
        this.optable[0xe2] = function () { self.memmode = self.INDEX; self.SBCB(); return 4; };
        this.optable[0xf2] = function () { self.memmode = self.EXTENDED; self.SBCB(); return 4; };

        //SEC
        this.optable[0x0d] = function () { self.memmode = self.INHERENT; self.SCC(); return 2; };

        //SEI	
        this.optable[0x0f] = function () { self.memmode = self.INHERENT; self.SEI(); return 2; };

        //SEV	
        this.optable[0x0b] = function () { self.memmode = self.INHERENT; self.SEV(); return 2; };

        //STAA	
        this.optable[0x97] = function () { self.memmode = self.DIRECT; self.STAA(); return 3; };
        this.optable[0xa7] = function () { self.memmode = self.INDEX; self.STAA(); return 4; };
        this.optable[0xb7] = function () { self.memmode = self.EXTENDED; self.STAA(); return 4; };

        //STAB	
        this.optable[0xd7] = function () { self.memmode = self.DIRECT; self.STAB(); return 3; };
        this.optable[0xe7] = function () { self.memmode = self.INDEX; self.STAB(); return 4; };
        this.optable[0xf7] = function () { self.memmode = self.EXTENDED; self.STAB(); return 4; };

        //STD	
        this.optable[0xdd] = function () { self.memmode = self.DIRECT; self.STD(); return 4; };
        this.optable[0xed] = function () { self.memmode = self.INDEX; self.STD(); return 5; };
        this.optable[0xfd] = function () { self.memmode = self.EXTENDED; self.STD(); return 5; };

        //STS	
        this.optable[0x9f] = function () { self.memmode = self.DIRECT; self.STS(); return 4; };
        this.optable[0xaf] = function () { self.memmode = self.INDEX; self.STS(); return 5; };
        this.optable[0xbf] = function () { self.memmode = self.EXTENDED; self.STS(); return 5; };

        //STX	
        this.optable[0xdf] = function () { self.memmode = self.DIRECT; self.STX(); return 4; };
        this.optable[0xef] = function () { self.memmode = self.INDEX; self.STX(); return 5; };
        this.optable[0xff] = function () { self.memmode = self.EXTENDED; self.STX(); return 5; };

        //SUBA	
        this.optable[0x80] = function () { self.memmode = self.IMMEDIATE; self.SUBA(); return 2; };
        this.optable[0x90] = function () { self.memmode = self.DIRECT; self.SUBA(); return 3; };
        this.optable[0xa0] = function () { self.memmode = self.INDEX; self.SUBA(); return 4; };
        this.optable[0xb0] = function () { self.memmode = self.EXTENDED; self.SUBA(); return 4; };

        //SUBB	
        this.optable[0xc0] = function () { self.memmode = self.IMMEDIATE; self.SUBB(); return 2; };
        this.optable[0xd0] = function () { self.memmode = self.DIRECT; self.SUBB(); return 3; };
        this.optable[0xe0] = function () { self.memmode = self.INDEX; self.SUBB(); return 4; };
        this.optable[0xf0] = function () { self.memmode = self.EXTENDED; self.SUBB(); return 4; };

        //SUBD	
        this.optable[0x83] = function () { self.memmode = self.IMMEDIATE; self.SUBD(); return 4; };
        this.optable[0x93] = function () { self.memmode = self.DIRECT; self.SUBD(); return 5; };
        this.optable[0xa3] = function () { self.memmode = self.INDEX; self.SUBD(); return 6; };
        this.optable[0xb3] = function () { self.memmode = self.EXTENDED; self.SUBD(); return 6; };

        //SWI	
        this.optable[0x3f] = function () { self.memmode = self.INHERENT; self.SWI(); return 12; };

        //TAB	
        this.optable[0x16] = function () { self.memmode = self.INHERENT; self.TAB(); return 2; };

        //TAP	
        this.optable[0x06] = function () { self.memmode = self.INHERENT; self.TAP(); return 2; };

        //TBA	
        this.optable[0x17] = function () { self.memmode = self.INHERENT; self.TBA(); return 2; };

        //TPA	
        this.optable[0x07] = function () { self.memmode = self.INHERENT; self.TPA(); return 2; };

        //TST	
        this.optable[0x6d] = function () { self.memmode = self.INDEX; self.TST(); return 6; };
        this.optable[0x7d] = function () { self.memmode = self.EXTENDED; self.TST(); return 6; };

        //TSTA	
        this.optable[0x4d] = function () { self.memmode = self.INHERENT; self.TSTA(); return 2; };

        //TSTB	
        this.optable[0x5d] = function () { self.memmode = self.INHERENT; self.TSTB(); return 2; };

        //TSX	
        this.optable[0x30] = function () { self.memmode = self.INHERENT; self.TSX(); return 3; };

        //TXS 
        this.optable[0x35] = function () { self.memmode = self.INHERENT; self.TXS(); return 3; };

        //WAI 
        this.optable[0x3e] = function () { self.memmode = self.INHERENT; self.WAI(); return 9; };

        //UNDOCUMENTED OPCODES
        this.optable[0x00] = function () { self.memmode = self.IMMEDIATE; self.CLB(); return 2; };
        this.optable[0x02] = function () { self.memmode = self.IMMEDIATE; self.SEXA(); return 2; };
        this.optable[0x03] = function () { self.memmode = self.IMMEDIATE; self.SETA(); return 2; };
        this.optable[0x12] = function () { self.memmode = self.IMMEDIATE; self.SCBA(); return 2; };
        this.optable[0x13] = function () { self.memmode = self.IMMEDIATE; self.SDBA(); return 2; };
        this.optable[0x14] = function () { self.memmode = self.IMMEDIATE; self.TDAB(); return 2; };
        this.optable[0x15] = function () { self.memmode = self.IMMEDIATE; self.TDBA(); return 2; };
        this.optable[0x18] = function () { self.memmode = self.IMMEDIATE; self.ABAX(); return 2; };
        this.optable[0x1a] = function () { self.memmode = self.IMMEDIATE; self.ABAX(); return 2; };
        this.optable[0x1c] = function () { self.memmode = self.IMMEDIATE; self.TDAB(); return 2; };
        this.optable[0x1d] = function () { self.memmode = self.IMMEDIATE; self.TDBC(); return 2; };
        this.optable[0x1e] = function () { self.memmode = self.IMMEDIATE; self.TAB(); return 2; };
        this.optable[0x1f] = function () { self.memmode = self.IMMEDIATE; self.TBAC(); return 2; };
        this.optable[0x41] = function () { self.memmode = self.IMMEDIATE; self.NGA(); return 2; };
        this.optable[0x45] = function () { self.memmode = self.IMMEDIATE; self.LSRA(); return 2; };
        this.optable[0x4b] = function () { self.memmode = self.IMMEDIATE; self.DCA(); return 2; };
        this.optable[0x4e] = function () { self.memmode = self.IMMEDIATE; self.ERROR(0x4e); return 2; };
        this.optable[0x51] = function () { self.memmode = self.IMMEDIATE; self.NGB(); return 2; };
        this.optable[0x55] = function () { self.memmode = self.IMMEDIATE; self.LSRB(); return 2; };
        this.optable[0x5b] = function () { self.memmode = self.IMMEDIATE; self.DCB(); return 2; };
        this.optable[0x5e] = function () { self.memmode = self.IMMEDIATE; self.ERROR(0x5e); return 2; };
        this.optable[0x61] = function () { self.memmode = self.INDEX; self.NGX(); return 6; };
        this.optable[0x65] = function () { self.memmode = self.INDEX; self.LSRX(); return 6; };
        this.optable[0x6b] = function () { self.memmode = self.INDEX; self.DCX(); return 6; };
        this.optable[0x71] = function () { self.memmode = self.EXTENDED; self.NGX(); return 6; };
        this.optable[0x75] = function () { self.memmode = self.EXTENDED; self.LSRX(); return 6; };
        this.optable[0x7b] = function () { self.memmode = self.EXTENDED; self.DCX(); return 6; };
        this.optable[0x87] = function () { self.memmode = self.IMMEDIATE; self.STAI(); return 2; };
        this.optable[0xc7] = function () { self.memmode = self.IMMEDIATE; self.STBI(); return 2; };
        this.optable[0xcd] = function () { self.memmode = self.IMMEDIATE; self.STDI(); return 3; };
        this.optable[0x8f] = function () { self.memmode = self.IMMEDIATE; self.STSI(); return 3; };
        this.optable[0xcf] = function () { self.memmode = self.IMMEDIATE; self.STXI(); return 3; };
    },

    ERROR: function (op) {
        console.debug("ERROR: unknown opcode: " + op);
    },
    ABA: function () {
        this.REG_A[0] = this.add(this.REG_A[0], this.REG_B[0]);
    },
    ABAX: function () {
        this.REG_A[0] = this.addx(this.REG_A[0], this.REG_B[0]);
    },
    ABX: function () {
        this.REG_IP += this.REG_B[0];
        this.REG_IP &= 0xffff;
    },
    ADCA: function () {
        this.REG_A[0] = this.addCarry(this.REG_A[0], this.fetchData());
    },
    ADCB: function () {
        this.REG_B[0] = this.addCarry(this.REG_B[0], this.fetchData());
    },
    ADDA: function () {
        this.REG_A[0] = this.add(this.REG_A[0], this.fetchData());
    },
    ADDB: function () {
        this.REG_B[0] = this.add(this.REG_B[0], this.fetchData());
    },
    ADDD: function () {
        this.REG_D[0] = this.add16(this.REG_D[0], this.fetchData16());
    },
    ANDA: function () {
        this.REG_A[0] = this.and(this.REG_A[0], this.fetchData());
    },
    ANDB: function () {
        this.REG_B[0] = this.and(this.REG_B[0], this.fetchData());
    },
    ASL: function () {
        var scratch = this.arithmeticShiftLeft(this.fetchData());
        this.setLastRead(scratch);
    },
    ASLA: function () {
        this.REG_A[0] = this.arithmeticShiftLeft(this.REG_A[0]);
    },
    ASLB: function () {
        this.REG_B[0] = this.arithmeticShiftLeft(this.REG_B[0]);
    },
    ASLD: function () {
        this.REG_D[0] = this.shiftLeft16(this.REG_D[0]);
    },
    ASR: function () {
        var scratch = this.arithmeticShiftRight(this.fetchData());
        this.setLastRead(scratch);
    },
    ASRA: function () {
        this.REG_A[0] = this.arithmeticShiftRight(this.REG_A[0]);
    },
    ASRB: function () {
        this.REG_B[0] = this.arithmeticShiftRight(this.REG_B[0]);
    },
    BRA: function () {
        var pos = this.signExtend(this.fetchData());
        this.REG_PC += pos;
        this.REG_PC &= 0xffff;
    },
    BRN: function () {
        this.fetchData();
    },
    BCC: function () {
        var pos = this.signExtend(this.fetchData());
        if (this.F_CARRY == 0) {
            this.REG_PC += pos;
            this.REG_PC &= 0xffff;
        }
    },
    BCS: function () {
        var pos = this.signExtend(this.fetchData());
        if (this.F_CARRY == 1) {
            this.REG_PC += pos;
            this.REG_PC &= 0xffff;
        }
    },
    BEQ: function () {
        var pos = this.signExtend(this.fetchData());
        if (this.F_ZERO == 1) {
            this.REG_PC += pos;
            this.REG_PC &= 0xffff;
        }
    },
    BGE: function () {
        var pos = this.signExtend(this.fetchData());
        if ((this.F_SIGN ^ this.F_OVERFLOW) == 0) {
            this.REG_PC += pos;
            this.REG_PC &= 0xffff;
        }
    },
    BGT: function () {
        var pos = this.signExtend(this.fetchData());
        if ((this.F_ZERO | (this.F_SIGN ^ this.F_OVERFLOW)) == 0) {
            this.REG_PC += pos;
            this.REG_PC &= 0xffff;
        }
    },
    BHI: function () {
        var pos = this.signExtend(this.fetchData());
        if ((this.F_CARRY | this.F_ZERO) == 0) {
            this.REG_PC += pos;
            this.REG_PC &= 0xffff;
        }
    },
    BLE: function () {
        var pos = this.signExtend(this.fetchData());
        if ((this.F_ZERO | (this.F_SIGN ^ this.F_OVERFLOW)) == 1) {
            this.REG_PC += pos;
            this.REG_PC &= 0xffff;
        }
    },
    BLS: function () {
        var pos = this.signExtend(this.fetchData());
        if ((this.F_CARRY | this.F_ZERO) == 1) {
            this.REG_PC += pos;
            this.REG_PC &= 0xffff;
        }
    },
    BLT: function () {
        var pos = this.signExtend(this.fetchData());
        if ((this.F_SIGN ^ this.F_OVERFLOW) == 1) {
            this.REG_PC += pos;
            this.REG_PC &= 0xffff;
        }
    },
    BMI: function () {
        var pos = this.signExtend(this.fetchData());
        if (this.F_SIGN == 1) {
            this.REG_PC += pos;
            this.REG_PC &= 0xffff;
        }
    },
    BNE: function () {
        var pos = this.signExtend(this.fetchData());
        if (this.F_ZERO == 0) {
            this.REG_PC += pos;
            this.REG_PC &= 0xffff;
        }
    },
    BVC: function () {
        var pos = this.signExtend(this.fetchData());
        if (this.F_OVERFLOW == 0) {
            this.REG_PC += pos;
            this.REG_PC &= 0xffff;
        }
    },
    BVS: function () {
        var pos = this.signExtend(this.fetchData());
        if (this.F_OVERFLOW == 1) {
            this.REG_PC += pos;
            this.REG_PC &= 0xffff;
        }
    },
    BPL: function () {
        var pos = this.signExtend(this.fetchData());
        if (this.F_SIGN == 0) {
            this.REG_PC += pos;
            this.REG_PC &= 0xffff;
        }
    },
    BSR: function () {
        var pos = this.signExtend(this.fetch());
        this.pushStack16(this.REG_PC);
        this.REG_PC += pos;
        this.REG_PC &= 0xffff;
    },
    BITA: function () {
        this.and(this.REG_A[0], this.fetchData());
    },
    BITB: function () {
        this.and(this.REG_B[0], this.fetchData());
    },
    CBA: function () {
        this.subtract(this.REG_A[0], this.REG_B[0]);
    },
    CLB: function () {
        this.REG_B[0] = 0; // flags unaffected
    },
    CLC: function () {
        this.F_CARRY = 0;
    },
    CLI: function () {
        this.F_INTERRUPT = 0;
        //this.emulate();
        //this.checkIRQLines();
    },
    CLR: function () {
        this.setMemory(this.fetchAddress(), 0);
        this.F_ZERO = 1;
        this.F_SIGN = 0;
        this.F_OVERFLOW = 0;
        this.F_CARRY = 0;
    },
    CLRA: function () {
        this.REG_A[0] = 0;
        this.F_SIGN = 0;
        this.F_OVERFLOW = 0;
        this.F_CARRY = 0;
        this.F_ZERO = 1;
    },
    CLRB: function () {
        this.REG_B[0] = 0;
        this.F_SIGN = 0;
        this.F_OVERFLOW = 0;
        this.F_CARRY = 0;
        this.F_ZERO = 1;
    },
    CLV: function () {
        this.F_OVERFLOW = 0;
    },
    CMPA: function () {
        this.subtract(this.REG_A[0], this.fetchData());
    },
    CMPB: function () {
        this.subtract(this.REG_B[0], this.fetchData());
    },
    COM: function () {
        var scratch = this.complement(this.fetchData());
        this.setLastRead(scratch);
    },
    COMA: function () {
        this.REG_A[0] = this.complement(this.REG_A[0]);
    },
    COMB: function () {
        this.REG_B[0] = this.complement(this.REG_B[0]);
    },
    CPX: function () {
        this.subtract16(this.REG_IP, this.fetchData16());
    },
    DAA: function () {
        this.REG_A[0] = this.decimalAdjust(this.REG_A[0]);
    },
    DCA: function () {
        this.REG_A[0] = this.decrementC(this.REG_A[0]);
    },
    DCB: function () {
        this.REG_B[0] = this.decrementC(this.REG_B[0]);
    },
    DCX: function () {
        var scratch = this.decrementC(this.fetchData());
        this.setLastRead(scratch);
    },
    DEC: function () {
        var scratch = this.decrement(this.fetchData());
        this.setLastRead(scratch);
    },
    DECA: function () {
        this.REG_A[0] = this.decrement(this.REG_A[0]);
    },
    DECB: function () {
        this.REG_B[0] = this.decrement(this.REG_B[0]);
    },
    DES: function () {
        this.REG_SP--;
        this.REG_SP &= 0xffff;
    },
    DEX: function () {
        this.REG_IP--;
        this.REG_IP &= 0xffff;
        this.set16Z(this.REG_IP);
    },
    EORA: function () {
        this.REG_A[0] = this.eor(this.REG_A[0], this.fetchData());
    },
    EORB: function () {
        this.REG_B[0] = this.eor(this.REG_B[0], this.fetchData());
    },
    INC: function () {
        var scratch = this.increment(this.fetchData());
        this.setLastRead(scratch);
    },
    INCA: function () {
        this.REG_A[0] = this.increment(this.REG_A[0]);
    },
    INCB: function () {
        this.REG_B[0] = this.increment(this.REG_B[0]);
    },
    INS: function () {
        this.REG_SP++;
        this.REG_SP &= 0xffff;
    },
    INX: function () {
        this.REG_IP++;
        this.REG_IP &= 0xffff;
        this.set16Z(this.REG_IP);
    },
    JMP: function () {
        var pos;
        if (this.memmode == this.INDEX) {
            pos = this.REG_IP + this.fetch();
        } else {
            pos = this.fetchAddress();
        }
        this.REG_PC = pos;
    },
    JSR: function () {
        var pos = this.fetchAddress();
        this.pushStack16(this.REG_PC);
        this.REG_PC = pos;
    },
    LDAA: function () {
        this.REG_A[0] = this.fetchData();
        this.set8NZ(this.REG_A[0]);
        this.F_OVERFLOW = 0;
    },
    LDAB: function () {
        this.REG_B[0] = this.fetchData();
        this.set8NZ(this.REG_B[0]);
        this.F_OVERFLOW = 0;
    },
    LDD: function () {
        this.REG_D[0] = this.fetchData16();
        this.set16NZ(this.REG_D[0]);
        this.F_OVERFLOW = 0;
    },
    LDS: function () {
        this.REG_SP = this.fetchData16();
        this.set16NZ(this.REG_SP);
        this.F_OVERFLOW = 0;
    },
    LDX: function () {
        var scratch = this.fetchData16();
        this.REG_IP = scratch;
        this.set16NZ(this.REG_IP);
        this.F_OVERFLOW = 0;
    },
    LSRX: function () {
        var scratch = this.logicalShiftRight(this.fetchData());
        // CCR only; does not set memory
    },
    LSR: function () {
        var scratch = this.logicalShiftRight(this.fetchData());
        this.setLastRead(scratch);
    },
    LSRA: function () {
        this.REG_A[0] = this.logicalShiftRight(this.REG_A[0]);
    },
    LSRB: function () {
        this.REG_B[0] = this.logicalShiftRight(this.REG_B[0]);
    },
    LSRD: function () {
        this.REG_D[0] = this.shiftRight16(this.REG_D[0]);
    },
    MUL: function () {
        this.REG_D[0] = (this.REG_A[0] * this.REG_B[0]) & 0xffff;
        this.F_CARRY = (this.REG_B[0] >> 7) & 1;
    },
    NEG: function () {
        var scratch = this.negate(this.fetchData());
        this.setLastRead(scratch);
    },
    NEGA: function () {
        this.REG_A[0] = this.negate(this.REG_A[0]);
    },
    NEGB: function () {
        this.REG_B[0] = this.negate(this.REG_B[0]);
    },
    NGA: function () {
        var scratch = this.negate(this.REG_A[0]);
        // do modify register
    },
    NGB: function () {
        var scratch = this.negate(this.REG_B[0]);
        // don't modify register
    },
    NGX: function () {
        var scratch = this.negate(this.fetchData());
        this.setLastRead(0xff);
    },
    NGC: function () { // undocumented
        var scratch = this.negateCarry(this.fetchData());
        this.setLastRead(scratch);
    },
    NGCA: function () { // undocumented
        this.REG_A[0] = this.negateCarry(this.REG_A[0]);
    },
    NGCB: function () { // undocumented
        this.REG_B[0] = this.negateCarry(this.REG_B[0]);
    },
    NOP: function () {
    },
    ORAA: function () {
        this.REG_A[0] = this.or(this.REG_A[0], this.fetchData());
    },
    ORAB: function () {
        this.REG_B[0] = this.or(this.REG_B[0], this.fetchData());
    },
    PSHA: function () {
        this.pushStack(this.REG_A[0]);
    },
    PSHB: function () {
        this.pushStack(this.REG_B[0]);
    },
    PSHX: function () {
        this.pushStack16(this.REG_IP);
    },
    PULA: function () {
        this.REG_A[0] = this.popStack();
    },
    PULB: function () {
        this.REG_B[0] = this.popStack();
    },
    PULX: function () {
        this.REG_IP = this.popStack16();
    },
    ROL: function () {
        var scratch = this.rotateLeft(this.fetchData());
        this.setLastRead(scratch);
    },
    ROLA: function () {
        this.REG_A[0] = this.rotateLeft(this.REG_A[0]);
    },
    ROLB: function () {
        this.REG_B[0] = this.rotateLeft(this.REG_B[0]);
    },
    ROR: function () {
        var scratch = this.rotateRight(this.fetchData());
        this.setLastRead(scratch);
    },
    RORA: function () {
        this.REG_A[0] = this.rotateRight(this.REG_A[0]);
    },
    RORB: function () {
        this.REG_B[0] = this.rotateRight(this.REG_B[0]);
    },
    RTI: function () {
        this.variableToFlags(this.popStack());
        this.REG_B[0] = this.popStack();
        this.REG_A[0] = this.popStack();
        this.REG_IP = this.popStack16();
        this.REG_PC = this.popStack16();
        //this.checkIRQLines();
    },
    RTS: function () {
        this.REG_PC = this.popStack16();
        if (this.mc10.isDebugging && this.mc10.isStepOut) {
            this.suspend();
        }
    },
    SBA: function () {
        this.REG_A[0] = this.subtract(this.REG_A[0], this.REG_B[0]);
    },
    SBCA: function () {
        this.REG_A[0] = this.subtractCarry(this.REG_A[0], this.fetchData());
    },
    SBCB: function () {
        this.REG_B[0] = this.subtractCarry(this.REG_B[0], this.fetchData());
    },
    SDBA: function () { // undocumented opcode $13
        this.F_CARRY = 1;
        this.REG_A[0] = this.subtractCarry(this.REG_A[0], this.REG_B[0]);
    },
    SCBA: function () { // undocumented opcode $12
        this.REG_A[0] = this.subtractCarry(this.REG_A[0], this.REG_B[0]);
    },
    SCC: function () {
        this.F_CARRY = 1;
    },
    SETA: function () { // undocumented
        this.REG_A[0] = 255;
        // registers unaffected
    },
    SEI: function () {
        this.F_INTERRUPT = 1;
        //this.emulate();
        //this.history = [];
        //this.checkIRQLines();
    },
    SEV: function () {
        this.F_OVERFLOW = 1;
    },

    STAI: function () { // undocumented opcode $87
        this.fetch();
        this.F_SIGN = 1;
        this.F_ZERO = 0;
        this.F_OVERFLOW = 0;
    },
    STBI: function () { // undocumented opcode $C7
        this.fetch();
        this.F_SIGN = 1;
        this.F_ZERO = 0;
        this.F_OVERFLOW = 0;
    },
    STDI: function () { // undocumented opcode $CD
        this.fetch();
        this.setMemory(this.REG_PC, this.REG_D[0] & 0xff);
        this.fetch();
        this.F_SIGN = 1;
        this.F_ZERO = 0;
        this.F_OVERFLOW = 0;
    },
    STSI: function () { // undocumented opcode $8F
        this.fetch();
        this.setMemory(this.REG_PC, 0xff);
        this.fetch();
        this.F_SIGN = 1;
        this.F_ZERO = 0;
        this.F_OVERFLOW = 0;
    },
    STXI: function () { // undocumented opcode $CF
        this.fetch();
        this.setMemory(this.REG_PC, this.REG_IP & 0xff);
        this.fetch();
        this.F_SIGN = 1;
        this.F_ZERO = 0;
        this.F_OVERFLOW = 0;
    },

    STAA: function () {
        this.setMemory(this.fetchAddress(), this.REG_A[0]);
        this.F_OVERFLOW = 0;
        this.set8NZ(this.REG_A[0]);
    },
    STAB: function () {
        this.setMemory(this.fetchAddress(), this.REG_B[0]);
        this.F_OVERFLOW = 0;
        this.set8NZ(this.REG_B[0]);
    },
    STD: function () {
        var scratch = this.fetchAddress();
        this.setMemory16(scratch, this.REG_D[0]);
        this.F_OVERFLOW = 0;
        this.set16NZ(this.REG_D[0]);
    },
    STS: function () {
        var scratch = this.fetchAddress();
        this.setMemory16(scratch, this.REG_SP);
        this.F_OVERFLOW = 0;
        this.set16NZ(this.REG_SP);
    },
    STX: function () {
        var scratch = this.fetchAddress();
        this.setMemory16(scratch, this.REG_IP);
        this.F_OVERFLOW = 0;
        this.set16NZ(this.REG_IP);
    },
    SUBA: function () {
        this.REG_A[0] = this.subtract(this.REG_A[0], this.fetchData());
    },
    SUBB: function () {
        this.REG_B[0] = this.subtract(this.REG_B[0], this.fetchData());
    },
    SUBD: function () {
        this.REG_D[0] = this.subtract16(this.REG_D[0], this.fetchData16());
    },
    SWI: function () {
        this.pushStack16(this.REG_PC);
        this.pushStack16(this.REG_IP);
        this.pushStack(this.REG_A[0]);
        this.pushStack(this.REG_B[0]);
        this.pushStack(this.flagsToVariable());

        this.SEI();

        this.REG_PC = ((this.fetchMemory(0xfffa) << 8) |
            (this.fetchMemory(0xfffb) & 0xff)) & 0xffff;
        this.REG_PC &= 0xffff;

        //                    return;
        //                    this.F_INTERRUPT = 1;
        //                    this.pushStack16(this.REG_PC);
        //                    this.pushStack16(this.REG_IP);
        //                    this.pushStack16(this.REG_A[0]);
        //                    this.pushStack16(this.REG_B[0]);
        //                    this.pushStack16(this.flagsToVariable());
        //                    this.REG_PC = (this.fetchMemory(0xfffa) << 8) + this.fetchMemory(0xfffb);
    },
    SEXA: function () { // undocumented
        this.REG_A[0] = this.F_CARRY ? 255 : 0;
        // registers unaffected
    },
    TAB: function () {
        this.REG_B[0] = this.REG_A[0];
        this.set8NZ(this.REG_B[0]);
        this.F_OVERFLOW = 0;
    },
    TAP: function () {
        this.variableToFlags(this.REG_A[0]);
        //this.emulate();
        //this.checkIRQLines();
    },
    TBA: function () {
        this.REG_A[0] = this.REG_B[0];
        this.set8NZ(this.REG_A[0]);
        this.F_OVERFLOW = 0;
    },
    TBAC: function () {
        this.REG_A[0] = this.REG_B[0];
        this.set8NZ(this.REG_A[0]);
        this.F_OVERFLOW = 0;
        this.F_CARRY = 1;
    },
    TDAB: function () { // undocumented
        this.REG_B[0] = this.decrement(this.REG_A[0]);
    },
    TDBA: function () { // undocumented
        this.REG_A[0] = this.decrement(this.REG_B[0]);
    },
    TDBC: function () { // undocumented
        this.REG_A[0] = this.decrementC(this.REG_B[0]);
    },
    TPA: function () {
        this.REG_A[0] = this.flagsToVariable();
    },
    TST: function () {
        this.F_OVERFLOW = 0;
        this.F_CARRY = 0;
        this.set8NZ(this.fetchData());
    },
    TSTA: function () {
        this.F_OVERFLOW = 0;
        this.F_CARRY = 0;
        this.set8NZ(this.REG_A[0]);
    },
    TSTB: function () {
        this.F_OVERFLOW = 0;
        this.F_CARRY = 0;
        this.set8NZ(this.REG_B[0]);
    },
    TSX: function () {
        this.REG_IP = this.REG_SP + 1;
    },
    TXS: function () {
        this.REG_SP = this.REG_IP - 1;
    },
    WAI: function () {
        this.waiState |= this.WAI_;
        this.pushStack16(this.REG_PC);
        this.pushStack16(this.REG_IP);
        this.pushStack(this.REG_A[0]);
        this.pushStack(this.REG_B[0]);
        this.pushStack(this.flagsToVariable());
        //this.checkIRQLines();

        if ((this.waiState & this.WAI_) != 0) {
            console.debug("eat cycles");
            this.cycleCount = (this.cycleCount + 1) & 0xffff;
            this.checkTimer();
        }
        console.debug("WAI called");
    },

    flagsToVariable: function () {
        var ret =
            this.F_CARRY * 0x01 +
            this.F_OVERFLOW * 0x02 +
            this.F_ZERO * 0x04 +
            this.F_SIGN * 0x08 +
            this.F_INTERRUPT * 0x10 +
            this.F_HALFCARRY * 0x20 +
            0x40 +
            0x80;
        return ret;
    },

    variableToFlags: function (CCR) {
        this.F_CARRY = (CCR & 0x01);
        this.F_OVERFLOW = (CCR & 0x02) >> 1;
        this.F_ZERO = (CCR & 0x04) >> 2;
        this.F_SIGN = (CCR & 0x08) >> 3;
        this.F_INTERRUPT = (CCR & 0x10) >> 4;
        this.F_HALFCARRY = (CCR & 0x20) >> 5;
    },

    fetch: function () {
        var scratch = this.fetchMemory(this.REG_PC);
        this.REG_PC++;
        this.REG_PC &= 0xffff;
        return scratch;
    },

    fetchOpCode: function () {
        return this.fetch();
    },

    fetchMemory: function (address) {
        address &= 0xffff;

        //was it chip or internal ram or external ram?
        if (((address >= 0x0080) && (address <= 0x00ff)) || ((address >= 0x4200) && (address <= this.mc10.maxRam))) {
            return this.memory[address];
        }

        //was it the BASIC ROM?
        if ((address >= 0xe000) && (address <= 0xffff)) {
            return this.mc10.ROM[address - 0xe000];
        }

        //was it the EXTERNAL ROM EXPANSION?
        //for this we'll just mirror the BASIC ROM..   
        if ((address >= 0xc000) && (address <= 0xdfff)) {
            return this.mc10.ROM[address - 0xc000];
        }

        //is it the video ram?
        if ((address >= 0x4000) && (address < 0x4200)) {
            return this.memory[address];
        }

        // is it the keybord input?  [partial emulation here, normally read from 0xbfff]
        // - to see this on a real MC-10, POKE 17032,0 will provide a memory dump.
        // - to see this on the emulator, POKE 17032,95
        // pressing the keys affect the video display of reads from 0x9000-0xbfff with 16K RAM.  
        // Note that we haven't completely emulated the return yet.

        if (0x9000 <= address && address <= 0xbfff) {
            var enb = this.memory[0x00] & ~this.memory[0x02];
            var ret =
                (enb & 0x01 ? this.port1[0] : 0xff) &
                (enb & 0x02 ? this.port1[1] : 0xff) &
                (enb & 0x04 ? this.port1[2] : 0xff) &
                (enb & 0x08 ? this.port1[3] : 0xff) &
                (enb & 0x10 ? this.port1[4] : 0xff) &
                (enb & 0x20 ? this.port1[5] : 0xff) &
                (enb & 0x40 ? this.port1[6] : address & 0xff | 0x3f) &
                (enb & 0x80 ? this.port1[7] : address & 0xff | 0x3f);
            return ret;
        }
        //is it an internal register?
        if (address <= 0x1f) {
            switch (address) {
                case 0x00: //Port 1 Data Direction Register
                case 0x01: //Port 2 Data Direction Register
                    return this.memory[address];

                case 0x02: //Port 1 Data Register (Keyboard Scan Strobe - Columns)
                    return this.memory[address];

                case 0x03: //Port 2 Data Register (Printer/Cassette and Keyboard)
                    {
                        var enb = this.memory[0x01];
                        var ret =
                            (~this.memory[0x02] & 0x01 ? this.port2[0] : 0xff) &
                            (0x02 ? this.port2[1] : 0xff) &
                            (~this.memory[0x02] & 0x04 ? this.port2[2] : 0xff) &
                            (0x08 ? this.port2[3] : 0xff) &
                            (0x10 ? this.port2[4] : 0xff) &
                            (0x20 ? this.port2[5] : 0xff) &
                            (0x40 ? this.port2[6] : 0xff) &
                            (~this.memory[0x02] & 0x80 ? this.port2[7] : 0xff);
                        return ret;
                    }
                case 0x04: //External Memory
                case 0x05: //External Memory
                case 0x06: //External Memory
                case 0x07: //External Memory
                    return this.memory[address];

                case 0x08: //Timer Control and Status Register (TCSR)
                    //this.clearTOF = this.memory[0x08] & this.TCSR_TOF;
                    //this.clearOCF = this.memory[0x08] & this.TCSR_OCF;
                    this.pendingTCSR = 0;
                    return this.memory[address];

                case 0x09: //Counter (High byte)
                    if ((this.pendingTCSR & this.TCSR_TOF) == 0) {
                        this.memory[0x08] &= ~(this.TCSR_TOF); // clear TOF flag on read
                        this.modifiedTCSR();
                    }
                    return (this.cycleCount >> 8) & 0xff;
                case 0x0a: //Counter (Low byte)
                    return this.cycleCount & 0xff;

                case 0x0b: //Output Compare Register (High byte)
                case 0x0c: //Output Compare Register (Low byte)
                    if (this.pendingTCSR & this.TCSR_OCF) {
                        this.memory[0x08] &= ~(this.TCSR_OCF); // clear OCF flag on read
                        this.modifiedTCSR();
                    }
                    //return (this.cycleCount >> 8) & 0xff;
                    //if (this.pendingTCSR & this.TCSR_OCF) {
                    //    this.memory[0x08] &= ~(this.TCSR_OCF); // clear OCF flag on read
                    //    this.modifiedTCSR();
                    //}
                    //return this.cycleCount & 0xff;
                    return this.memory[address];

                case 0x0d: //Input Capture Register (High byte)
                    if (this.pendingTCSR & this.TCSR_ICF) {
                        this.memory[0x08] &= ~(this.TCSR_ICF); // clear ICF flag on read
                        this.modifiedTCSR();
                    }
                    return this.memory[address];
                case 0x0e: //Input Capture Register (Low byte)
                case 0x0f: //External Memory
                    return this.memory[address];

                case 0x10: //Rate and Mode Control Register
                    break;

                case 0x11: //Transmit/Recieve Control and Status Register
                    return this.memory[address];

                case 0x12: //Recieve Data Register
                    return this.memory[address];

                case 0x13: //Transmit Data Register
                    return this.memory[address];

                case 0x14: //RAM Control Register
                    return this.memory[address];

                default:
                    console.debug("FATAL: Attempted to read to reserved internal register area:" + address);
                    //           printf("(%x) Attempted to read to reserved internal register area %x.\n",optable[0x00]->Program_Counter-1,address);
                    return 0x00;
            }
        }

        // nothing on the bus.  Just let it grab back the address line.
        return 0xff & address;
    },

    fetchAddress: function () {
        switch (this.memmode) {
            case this.DIRECT:
                return this.fetch();
            case this.INDEX:
                return this.fetch() + this.REG_IP;
            case this.EXTENDED:
                return (this.fetch() << 8) + this.fetch();
            default:
                console.debug("Tried FetchAddress with mode" + this.memmode);
                return 0;
        }
    },

    fetchData: function () {
        switch (this.memmode) {
            case this.IMMEDIATE:
            case this.RELATIVE:
                return this.fetch();
            case this.INDEX:
                return this.fetchMemory(this.fetch() + this.REG_IP);
            case this.DIRECT:
                return this.fetchMemory(this.fetch());
            case this.EXTENDED:
                return this.fetchMemory((this.fetch() << 8) + this.fetch());
            default:
                console.debug("Invalid mode in fetchData");
                return 0;
        }
    },

    fetchData16: function () {
        var scratch;
        switch (this.memmode) {
            case this.IMMEDIATE:
                return (this.fetch() << 8) + this.fetch();
            case this.INDEX:
                scratch = this.fetch() + this.REG_IP;
                break;
            case this.DIRECT:
                scratch = this.fetch();
                break;
            case this.EXTENDED:
                scratch = (this.fetch() << 8) + this.fetch();
                break;
            default:
                console.debug("Invalid mode in fetchData16");
                return 0;
        }
        //return ((this.fetchMemory(scratch) << 8) + this.fetchMemory(scratch + 1)) & 0xffff;
        return ((this.fetchMemory(scratch) << 8) + this.fetchMemory(scratch + 1));
    },

    setMemory: function (address, value) {
        address &= 0xffff;
        value &= 0xff;

        //is it video ram?
        if ((address >= 0x4000) && (address < 0x5800)) {
            this.memory[address] = value;
            if (this.mc10.vdg.vramIs4k) {
                if (address < 0x5000) {
                    this.mc10.vdg.updateDisplay(address & 0x0fff, value);
                    if (this.mc10.vdg.graphicsMode == 11 || this.mc10.vdg.graphicsMode == 15) {
                        this.mc10.vdg.updateDisplay(address & 0x0fff | 0x1000, value);
                    }
                }
            } else {
                this.mc10.vdg.updateDisplay(address - 0x4000, value);
            }
            return;
        }

        //is it writable ram?
        //!!!!!!!!!!!!!! < or <= 0x8fff
        if (((address >= 0x0080) && (address < 0x0100)) || ((address >= 0x4200) && (address <= this.mc10.maxRam))) {
            this.memory[address] = value;
            return;
        }

        //is it VDG and SOUND O/P? [normally written to 0xbfff]
        if (address >= 0x9000 && address < 0xc000) {
            if (this.mc10.vdg.updateChip(value)) {
                //redraw entire framebuffer on change of palette or video mode
                if (this.mc10.vdg.vramIs4k) {
                    for (var i = 0; i < 0x1800; i++) {
                        this.mc10.vdg.updateDisplay(i, this.memory[0x4000 + (i & 0x0fff)]);
                    }
                } else {
                    for (var i = 0; i < 0x1800; i++) {
                        this.mc10.vdg.updateDisplay(i, this.memory[0x4000 + i]);
                    }
                }
            }
            return;
        }

        //is it an internal register?
        if (address <= 0x1f) {
            switch (address) {
                case 0x00: //port 1 direction register
                case 0x01: //port 2 direction register
                    this.memory[address] = value;
                    return;

                case 0x02: //port 1 Data Register
                    this.memory[address] = value;
                    return;

                case 0x03: //port 2 Data Register
                    this.memory[address] = value;
                    //
                    // printer emulation (push output to console)
                    //
                    this.printBuffer.push(value & 0x01);
                    var len = this.printBuffer.length;
                    if ((len % 11) == 0) {
                        var char = 0x00;
                        for (var i = 0; i < 8; i++) {
                            char |= (this.printBuffer[len - 9 + i] ? 1 << i : 0);
                        }
                        console.log(String.fromCharCode(char));
                    }
                    clearTimeout(this.idleTimer);
                    var self = this;
                    this.idleTimer = setTimeout(function () {
                        self.printBuffer = [];
                    }, 100); // idle timer
                    return;

                case 0x04: //external memory
                case 0x05:
                case 0x06:
                case 0x07:
                    this.memory[address] = value;
                    return;

                case 0x08: //timer control register
                    //   if (value > 31) //only bits 0-4 are writable
                    //       break;
                    this.memory[0x08] = (this.memory[0x08] & 0xe0) + (value & 0x1f);
                    this.pendingTCSR &= this.memory[0x08];
                    this.modifiedTCSR();
                    if (this.F_INTERRUPT == 0) {
                        //                        this.checkIRQ2();
                    }
                    return;

                case 0x09: //preset timer counter on write
                    this.cycleCount = (0xfff8);
                case 0x0a:
                    return;

                case 0x0b: //output compare register
                case 0x0c:
                    //if (this.clearOCF) {
                    //    this.memory[0x08] &= ~(0x40); // clear OCF flag on read
                    //    this.clearOCF = false;
                    //}
                    if ((this.pendingTCSR & this.TCSR_OCF) == 0) {
                        this.memory[0x08] &= ~this.TCSR_OCF;
                    }

                    this.memory[address] = value;
                    return;

                case 0x0d: //input capture register (readonly)
                case 0x0e:
                    break;

                case 0x0f: //external memory
                    this.memory[0x0f] = value;
                    return;

                case 0x10:
                case 0x11:
                case 0x12:
                case 0x13:
                case 0x14:

                default:
                    console.debug("Attempted to write to reserved internal register area." + address);
            }
        }
    },

    setMemory16: function (address, value) {
        address &= 0xffff;
        value &= 0xffff;
        this.setMemory(address, value >> 8);
        this.setMemory(address + 1, value & 0xff);
    },

    setLastRead: function (value) {
        value &= 0xff;
        var position;
        switch (this.memmode) {
            case this.DIRECT:
                position = this.fetchMemory(this.REG_PC - 1);
                break;
            case this.INDEX:
                position = this.fetchMemory(this.REG_PC - 1) + this.REG_IP;
                break;
            case this.EXTENDED:
                position = (this.fetchMemory(this.REG_PC - 2) << 8) + this.fetchMemory(this.REG_PC - 1);
                break;
            default:
                console.debug("Tried to set last read with mode " + this.memmode);
                position = 0;
        }
        this.setMemory(position, value);
    },

    pushStack: function (value) {
        this.setMemory(this.REG_SP, value);
        this.REG_SP--;
        this.REG_SP &= 0xffff;
    },

    pushStack16: function (value) {
        this.setMemory16(this.REG_SP - 1, value);
        this.REG_SP -= 2;
        this.REG_SP &= 0xffff;
    },

    popStack: function () {
        this.REG_SP++;
        this.REG_SP &= 0xffff;
        return this.fetchMemory(this.REG_SP);
    },

    popStack16: function () {
        this.REG_SP += 2;
        this.REG_SP &= 0xffff;
        return this.fetchMemory(this.REG_SP) + (this.fetchMemory(this.REG_SP - 1) << 8);
    },

    add: function (first, second) {
        first &= 0xff;
        second &= 0xff;
        var scratch = first + second;
        this.set8HNZVC(first, second, (scratch & 0xffff));
        return (scratch & 0xff);
    },

    addx: function (first, second) {
        first &= 0xff;
        second &= 0xff;
        var scratch = first + second;
        this.set8NZ(scratch & 0xff);
        this.set8V(first, second, scratch);
        return (scratch & 0xff);
    },

    addCarry: function (first, second) {
        first &= 0xff;
        second &= 0xff;
        var scratch = first + second + this.F_CARRY;
        this.set8HNZVC(first, second, (scratch & 0xffff));
        return (scratch & 0xff);
    },

    add16: function (first, second) {
        first &= 0xffff;
        second &= 0xffff;
        var scratch = first + second;
        this.set16NZVC(first, second, (scratch & 0xffffffff));
        return (scratch & 0xffff);
    },

    subtract: function (first, second) {
        first &= 0xff;
        second &= 0xff;
        var scratch = first - second;
        this.set8NZVC(first, second, (scratch & 0xffff));
        return (scratch & 0xff);
    },

    subtract16: function (first, second) {
        first &= 0xffff;
        second &= 0xffff;
        var scratch = first - second;
        this.set16NZVC(first, second, (scratch & 0xffffffff));
        return (scratch & 0xffff);
    },

    subtractCarry: function (first, second) {
        first &= 0xff;
        second &= 0xff;
        var scratch = first - second - this.F_CARRY;
        this.set8NZVC(first, second, (scratch & 0xffff));
        return (scratch & 0xff);
    },

    and: function (first, second) {
        first &= 0xff;
        second &= 0xff;
        var result = first & second;
        this.set8NZ(result & 0xff);
        this.F_OVERFLOW = 0;
        //this.F_CARRY = 0; // Why do you carry with and? surely 0xff & 0xff is just 0xff.... (no carry?)
        return (result & 0xff);
    },

    complement: function (first) {
        first &= 0xff;
        var result = first ^ 0xff;
        this.set8NZ(result & 0xff);
        this.F_OVERFLOW = 0;
        this.F_CARRY = 1;
        return (result & 0xff);
    },

    eor: function (first, second) {
        first &= 0xff;
        second &= 0xff;
        var result = first ^ second;
        this.set8NZ(result & 0xff);
        this.F_OVERFLOW = 0;
        return (result & 0xff);
    },

    negate: function (first) {
        return this.subtract(0, first);
    },

    negateCarry: function (first) {
        return this.subtractCarry(0, first);
    },

    or: function (first, second) {
        first &= 0xff;
        second &= 0xff;
        var result = first | second;
        this.set8NZ(result & 0xff);
        this.F_OVERFLOW = 0;
        return (result & 0xff);
    },

    decrementC: function (first) {
        first &= 0xff;
        this.F_OVERFLOW = (first == 0x80) ? 1 : 0;
        this.F_CARRY = (first == 0x00) ? 0 : 1;
        var result = (first - 1) & 0xff;
        this.set8NZ(result);
        return (result);
    },

    decrement: function (first) {
        first &= 0xff;
        this.F_OVERFLOW = (first == 0x80) ? 1 : 0;
        var result = (first - 1) & 0xff;
        this.set8NZ(result);
        return (result);
    },

    increment: function (first) {
        first &= 0xff;
        this.F_OVERFLOW = (first == 0x7f) ? 1 : 0;
        var result = (first + 1) & 0xff;
        this.set8NZ(result);
        return (result);
    },

    shiftLeft: function (first, mode) {
        first &= 0xff;
        var result = (first << 1) & 0xff;
        if (mode == 3) {
            result += this.F_CARRY;
        }
        this.F_CARRY = ((first & 0x80) >> 7);
        this.set8NZ(result);
        this.F_OVERFLOW = (this.F_SIGN ^ this.F_CARRY);
        return (result & 0xff);
    },

    arithmeticShiftLeft: function (first) {
        return this.shiftLeft(first, 1);
    },

    rotateLeft: function (first) {
        return this.shiftLeft(first, 3);
    },

    shiftLeft16: function (first) {
        first &= 0xffff;
        var result = (first << 1) & 0xffff;
        this.F_CARRY = ((first & 0x8000) >> 15);
        this.set16NZ(result);
        this.F_OVERFLOW = (this.F_SIGN ^ this.F_CARRY);
        return (result & 0xffff);
    },

    shiftRight16: function (first) {
        first &= 0xffff;
        var result = (first >> 1) & 0xffff;
        this.F_CARRY = (first & 0x01);
        this.set16NZ(result);
        this.F_OVERFLOW = (this.F_SIGN ^ this.F_CARRY);
        return (result & 0xffff);
    },

    shiftRight: function (first, mode) {
        first &= 0xff;
        var result = (first >> 1) & 0xff;
        switch (mode) {
            case 1:
                result |= (first & 0x80);
                break;
            case 3:
                result |= (this.F_CARRY << 7);
                break;
            case 2:
                break;
            default:
                console.debug("Bad shift");
        }
        this.F_CARRY = (first & 0x01);
        this.set8NZ(result);
        this.F_OVERFLOW = (this.F_SIGN ^ this.F_CARRY);
        return (result & 0xff);
    },

    decimalAdjust: function (first) {

        var msn = first & 0xf0;
        var lsn = first & 0x0f;

        var second = 0;

        if (lsn > 0x09 || this.F_HALFCARRY) second |= 0x06;
        if (msn > 0x90 || this.F_CARRY) second |= 0x60;
        if (msn > 0x80 && lsn > 0x09) second |= 0x60;

        var origH = this.F_HALFCARRY;
        var origC = this.F_CARRY;

        var tmp = this.add(first, second);

        this.F_HALFCARRY = origH;
        this.F_CARRY |= origC;

        return tmp;
    },

    arithmeticShiftRight: function (first) {
        return this.shiftRight(first, 1);
    },

    logicalShiftRight: function (first) {
        return this.shiftRight(first, 2);
    },

    rotateRight: function (first) {
        return this.shiftRight(first, 3);
    },

    set8N: function (value) {
        this.F_SIGN = (value & 0x80) >> 7;
    },

    set16N: function (value) {
        this.F_SIGN = (value & 0x8000) >> 15;
    },

    set8Z: function (value) {
        this.F_ZERO = (value & 0xff) == 0 ? 1 : 0;
    },

    set16Z: function (value) {
        this.F_ZERO = (value & 0xffff) == 0 ? 1 : 0;
    },

    set8H: function (first, second, result) {
        this.F_HALFCARRY = ((first ^ second ^ result) & 0x10) >> 4;
    },

    set8C: function (value) {
        this.F_CARRY = (value & 0x100) >> 8;
    },

    set16C: function (value) {
        this.F_CARRY = (value & 0x10000) >> 16;
    },

    set8V: function (first, second, result) {
        this.F_OVERFLOW = ((first ^ second ^ result ^ (result >> 1)) & 0x80) >> 7;
    },

    set16V: function (first, second, result) {
        this.F_OVERFLOW = ((first ^ second ^ result ^ (result >> 1)) & 0x8000) >> 15;
    },

    set8NZ: function (value) {
        this.set8N(value);
        this.set8Z(value);
    },

    set16NZ: function (value) {
        this.set16N(value);
        this.set16Z(value);
    },

    set8HNZVC: function (first, second, result) {
        this.set8NZVC(first, second, result);
        this.set8H(first, second, result);
    },

    set8NZVC: function (first, second, result) {
        this.set8NZ(result & 0xff);
        this.set8V(first, second, result);
        this.set8C(result);
    },

    set16NZVC: function (first, second, result) {
        this.set16NZ(result & 0xffff);
        this.set16V(first, second, result);
        this.set16C(result);
    },

    signExtend: function (value) {
        return value < 128 ? value : value - 256;
    },

    mnemonics: ['CLB ', 'NOP ', 'SEXA', 'SETA', 'LSRD', 'ASLD', 'TAP ', 'TPA ', 'INX ', 'DEX ', 'CLV ', 'SEV ', 'CLC ', 'SEC ', 'CLI ', 'SEI ',
        'SBA ', 'CBA ', 'SCBA', 'SDBA', 'TDAB', 'TDBA', 'TAB ', 'TBA ', 'ABA ', 'DAA ', 'ABA ', 'ABA ', 'TDAB', 'TDBC', 'TAB ', 'TBAC',
        'BRA ', 'BRN ', 'BHI ', 'BLS ', 'BCC ', 'BCS ', 'BNE ', 'BEQ ', 'BVC ', 'BVS ', 'BPL ', 'BMI ', 'BGE ', 'BLT ', 'BGT ', 'BLE ',
        'TSX ', 'INS ', 'PULA', 'PULB', 'DES ', 'TXS ', 'PHSA', 'PSHB', 'PULX', 'RTS ', 'ABX ', 'RTI ', 'PSHX', 'MUL ', 'WAI ', 'SWI ',
        'NEGA', '.41 ', '.42 ', 'COMA', 'LSRA', '.45 ', 'RORA', 'ASRA', 'ASLA', 'ROLA', 'DECA', '.4B ', 'INCA', 'TSTA', 'T4E ', 'CLRA',
        'NEGB', '.51 ', '.52 ', 'COMB', 'LSRB', '.55 ', 'RORB', 'ASRB', 'ASLB', 'ROLB', 'DECB', '.5B ', 'INCB', 'TSTB', 'T5E ', 'CLRB',
        'NEG ', '.61 ', '.62 ', 'COM ', 'LSR ', '.65 ', 'ROR ', 'ASR ', 'ASL ', 'ROL ', 'DEC ', '.6B ', 'INC ', 'TST ', 'JMP ', 'CLR ',
        'NEG ', '.71 ', '.72 ', 'COM ', 'LSR ', '.75 ', 'ROR ', 'ASR ', 'ASL ', 'ROL ', 'DEC ', '.7B ', 'INC ', 'TST ', 'JMP ', 'CLR ',
        'SUBA', 'CMPA', 'SBCA', 'SUBD', 'ANDA', 'BITA', 'LDAA', '.87 ', 'EORA', 'ADCA', 'ORAA', 'ADDA', 'CMPX', 'BSR ', 'LDS ', '.8F ',
        'SUBA', 'CMPA', 'SBCA', 'SUBD', 'ANDA', 'BITA', 'LDAA', 'STAA', 'EORA', 'ADCA', 'ORAA', 'ADDA', 'CMPX', 'JSR ', 'LDS ', 'STS ',
        'SUBA', 'CMPA', 'SBCA', 'SUBD', 'ANDA', 'BITA', 'LDAA', 'STAA', 'EORA', 'ADCA', 'ORAA', 'ADDA', 'CMPX', 'JSR ', 'LDS ', 'STS ',
        'SUBA', 'CMPA', 'SBCA', 'SUBD', 'ANDA', 'BITA', 'LDAA', 'STAA', 'EORA', 'ADCA', 'ORAA', 'ADDA', 'CMPX', 'JSR ', 'LDS ', 'STS ',
        'SUBB', 'CMPB', 'SBCB', 'ADDD', 'ANDB', 'BITB', 'LDAB', '.C7 ', 'EORB', 'ADCB', 'ORAB', 'ADDB', 'LDD ', '.CD ', 'LDX ', '.CF ',
        'SUBB', 'CMPB', 'SBCB', 'ADDD', 'ANDB', 'BITB', 'LDAB', 'STAB', 'EORB', 'ADCB', 'ORAB', 'ADDB', 'LDD ', 'STD ', 'LDX ', 'STX ',
        'SUBB', 'CMPB', 'SBCB', 'ADDD', 'ANDB', 'BITB', 'LDAB', 'STAB', 'EORB', 'ADCB', 'ORAB', 'ADDB', 'LDD ', 'STD ', 'LDX ', 'STX ',
        'SUBB', 'CMPB', 'SBCB', 'ADDD', 'ANDB', 'BITB', 'LDAB', 'STAB', 'EORB', 'ADCB', 'ORAB', 'ADDB', 'LDD ', 'STD ', 'LDX ', 'STX ',
    ],

    disassemble: function (address) {
        var op = this.fetchMemory(address);
        var opstr = this.mnemonics[op];
        if ((op & 0xf0) == 0x20 || op == 0x8d) { //relative
            var dest = this.fetchMemory((address + 1) & 0xffff);
            dest = dest & 0x80 ? dest | 0xff00 : dest;
            dest = (address + 2 + dest) & 0xffff;
            return (opstr + "  " + dest.toString(16));
        } else if ((op & 0xf0) == 0x60 | (op & 0xf0) == 0xa0 | (op & 0xf0) == 0xe0) { //indexed
            var offset = this.fetchMemory((address + 1) & 0xffff);
            return (opstr + "  " + offset.toString(16) + ",X");
        } else if ((op & 0xf0) == 0x70 | (op & 0xf0) == 0xb0 | (op & 0xf0) == 0xf0) { // extended
            var mem16 = (this.fetchMemory((address + 1) & 0xffff) << 8) + this.fetchMemory((address + 2) & 0xffff);
            return (opstr + "  " + mem16.toString(16));
        } else if ((op & 0xf0) == 0x90 | (op & 0xf0) == 0xd0) { // direct
            var mem8 = this.fetchMemory((address + 1) & 0xffff);
            return (opstr + "  " + mem8.toString(16));
        } else if ((op & 0xf0) == 0x80 | (op & 0xf0) == 0xc0) {
            var imm = this.fetchMemory((address + 1) & 0xffff);
            if ((op & 0xf) == 0x3 | (op & 0xf) > 0xb) {
                imm = (imm << 8) + this.fetchMemory((address + 2) & 0xffff);
            }
            return (opstr + " #" + imm.toString(16));
        } else {
            return (opstr);
        }
    }
}

MC10.MC6847 = function (mc10) {
    this.mc10 = mc10;

    this.graphicsMode = null;
    this.palette = null;
    this.audio = null;
    this.screen = null;
    this.ctx = null;
    this.imageData = null;
    this.toggleSpeaker = null;
    this.sample = null;
    this.audioInterval = null;

    this.screen = document.getElementById("screen");
    this.ctx = this.screen.getContext("2d");
    this.ctx.fillStyle = "black";
    this.ctx.fillRect(0, 0, 512, 384);
    this.imageData = this.ctx.getImageData(0, 0, 512, 384);
    try {
        // Fix up for prefixing
        window.AudioContext = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioContext();
    }
    catch (e) {
        console.log('Web Audio API is not supported in this browser');
    }
    //this.init();
};

MC10.MC6847.SG4Rectangle = [
    //empty block
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    //lower right
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f],
    //lower left
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0],
    //bottom row
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    //upper right
    [0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    //right side
    [0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f],
    //bottom left, upper right
    [0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0],
    //upper left empty
    [0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    //upper left
    [0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    //upper left, lower right
    [0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f],
    //left side
    [0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0],
    //upper right empty
    [0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    //top
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    //lower left empty
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f],
    //lwoer right empty
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0],
    //all full
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
]; //SG4Rectangle

MC10.MC6847.SG6Rectangle = [
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0f, 0x0f, 0x0f, 0x0f],
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0xf0, 0xf0, 0xf0],
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff],
    [0x00, 0x00, 0x00, 0x00, 0x0f, 0x0f, 0x0f, 0x0f, 0x00, 0x00, 0x00, 0x00],
    [0x00, 0x00, 0x00, 0x00, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f],
    [0x00, 0x00, 0x00, 0x00, 0x0f, 0x0f, 0x0f, 0x0f, 0xf0, 0xf0, 0xf0, 0xf0],
    [0x00, 0x00, 0x00, 0x00, 0x0f, 0x0f, 0x0f, 0x0f, 0xff, 0xff, 0xff, 0xff],
    [0x00, 0x00, 0x00, 0x00, 0xf0, 0xf0, 0xf0, 0xf0, 0x00, 0x00, 0x00, 0x00],
    [0x00, 0x00, 0x00, 0x00, 0xf0, 0xf0, 0xf0, 0xf0, 0x0f, 0x0f, 0x0f, 0x0f],
    [0x00, 0x00, 0x00, 0x00, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0],
    [0x00, 0x00, 0x00, 0x00, 0xf0, 0xf0, 0xf0, 0xf0, 0xff, 0xff, 0xff, 0xff],
    [0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00],
    [0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x0f, 0x0f, 0x0f],
    [0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xf0, 0xf0, 0xf0, 0xf0],
    [0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    [0x0f, 0x0f, 0x0f, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    [0x0f, 0x0f, 0x0f, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x0f, 0x0f, 0x0f, 0x0f],
    [0x0f, 0x0f, 0x0f, 0x0f, 0x00, 0x00, 0x00, 0x00, 0xf0, 0xf0, 0xf0, 0xf0],
    [0x0f, 0x0f, 0x0f, 0x0f, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff],
    [0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x00, 0x00, 0x00, 0x00],
    [0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f],
    [0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0xf0, 0xf0, 0xf0, 0xf0],
    [0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0xff, 0xff, 0xff, 0xff],
    [0x0f, 0x0f, 0x0f, 0x0f, 0xf0, 0xf0, 0xf0, 0xf0, 0x00, 0x00, 0x00, 0x00],
    [0x0f, 0x0f, 0x0f, 0x0f, 0xf0, 0xf0, 0xf0, 0xf0, 0x0f, 0x0f, 0x0f, 0x0f],
    [0x0f, 0x0f, 0x0f, 0x0f, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0],
    [0x0f, 0x0f, 0x0f, 0x0f, 0xf0, 0xf0, 0xf0, 0xf0, 0xff, 0xff, 0xff, 0xff],
    [0x0f, 0x0f, 0x0f, 0x0f, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00],
    [0x0f, 0x0f, 0x0f, 0x0f, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x0f, 0x0f, 0x0f],
    [0x0f, 0x0f, 0x0f, 0x0f, 0xff, 0xff, 0xff, 0xff, 0xf0, 0xf0, 0xf0, 0xf0],
    [0x0f, 0x0f, 0x0f, 0x0f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    [0xf0, 0xf0, 0xf0, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    [0xf0, 0xf0, 0xf0, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x0f, 0x0f, 0x0f, 0x0f],
    [0xf0, 0xf0, 0xf0, 0xf0, 0x00, 0x00, 0x00, 0x00, 0xf0, 0xf0, 0xf0, 0xf0],
    [0xf0, 0xf0, 0xf0, 0xf0, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff],
    [0xf0, 0xf0, 0xf0, 0xf0, 0x0f, 0x0f, 0x0f, 0x0f, 0x00, 0x00, 0x00, 0x00],
    [0xf0, 0xf0, 0xf0, 0xf0, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f],
    [0xf0, 0xf0, 0xf0, 0xf0, 0x0f, 0x0f, 0x0f, 0x0f, 0xf0, 0xf0, 0xf0, 0xf0],
    [0xf0, 0xf0, 0xf0, 0xf0, 0x0f, 0x0f, 0x0f, 0x0f, 0xff, 0xff, 0xff, 0xff],
    [0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0x00, 0x00, 0x00, 0x00],
    [0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0x0f, 0x0f, 0x0f, 0x0f],
    [0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0],
    [0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xff, 0xff, 0xff, 0xff],
    [0xf0, 0xf0, 0xf0, 0xf0, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00],
    [0xf0, 0xf0, 0xf0, 0xf0, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x0f, 0x0f, 0x0f],
    [0xf0, 0xf0, 0xf0, 0xf0, 0xff, 0xff, 0xff, 0xff, 0xf0, 0xf0, 0xf0, 0xf0],
    [0xf0, 0xf0, 0xf0, 0xf0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    [0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    [0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x0f, 0x0f, 0x0f, 0x0f],
    [0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xf0, 0xf0, 0xf0, 0xf0],
    [0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff],
    [0xff, 0xff, 0xff, 0xff, 0x0f, 0x0f, 0x0f, 0x0f, 0x00, 0x00, 0x00, 0x00],
    [0xff, 0xff, 0xff, 0xff, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f],
    [0xff, 0xff, 0xff, 0xff, 0x0f, 0x0f, 0x0f, 0x0f, 0xf0, 0xf0, 0xf0, 0xf0],
    [0xff, 0xff, 0xff, 0xff, 0x0f, 0x0f, 0x0f, 0x0f, 0xff, 0xff, 0xff, 0xff],
    [0xff, 0xff, 0xff, 0xff, 0xf0, 0xf0, 0xf0, 0xf0, 0x00, 0x00, 0x00, 0x00],
    [0xff, 0xff, 0xff, 0xff, 0xf0, 0xf0, 0xf0, 0xf0, 0x0f, 0x0f, 0x0f, 0x0f],
    [0xff, 0xff, 0xff, 0xff, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0],
    [0xff, 0xff, 0xff, 0xff, 0xf0, 0xf0, 0xf0, 0xf0, 0xff, 0xff, 0xff, 0xff],
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00],
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x0f, 0x0f, 0x0f],
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xf0, 0xf0, 0xf0, 0xf0],
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
]; //SG6Rectangle

MC10.MC6847.SG4CharacterSet = [
    //@
    [0x00, 0x00, 0x00, 0x1c, 0x22, 0x02, 0x12, 0x2a, 0x2a, 0x1e, 0x00, 0x00],
    //A
    [0x00, 0x00, 0x00, 0x08, 0x14, 0x22, 0x22, 0x3e, 0x22, 0x22, 0x00, 0x00],
    //B
    [0x00, 0x00, 0x00, 0x3c, 0x12, 0x12, 0x1c, 0x12, 0x12, 0x3c, 0x00, 0x00],
    //C
    [0x00, 0x00, 0x00, 0x1c, 0x22, 0x20, 0x20, 0x20, 0x22, 0x1c, 0x00, 0x00],
    //D
    [0x00, 0x00, 0x00, 0x3c, 0x12, 0x12, 0x12, 0x12, 0x12, 0x3c, 0x00, 0x00],
    //E
    [0x00, 0x00, 0x00, 0x3e, 0x20, 0x20, 0x3c, 0x20, 0x20, 0x3e, 0x00, 0x00],
    //F
    [0x00, 0x00, 0x00, 0x3e, 0x20, 0x20, 0x3c, 0x20, 0x20, 0x20, 0x00, 0x00],
    //G
    [0x00, 0x00, 0x00, 0x1e, 0x20, 0x20, 0x26, 0x22, 0x22, 0x1e, 0x00, 0x00],
    //H
    [0x00, 0x00, 0x00, 0x22, 0x22, 0x22, 0x3e, 0x22, 0x22, 0x22, 0x00, 0x00],
    //I
    [0x00, 0x00, 0x00, 0x1c, 0x08, 0x08, 0x08, 0x08, 0x08, 0x1c, 0x00, 0x00],
    //J
    [0x00, 0x00, 0x00, 0x02, 0x02, 0x02, 0x02, 0x22, 0x22, 0x1c, 0x00, 0x00],
    //K
    [0x00, 0x00, 0x00, 0x22, 0x24, 0x28, 0x30, 0x28, 0x24, 0x22, 0x00, 0x00],
    //L
    [0x00, 0x00, 0x00, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x3e, 0x00, 0x00],
    //M
    [0x00, 0x00, 0x00, 0x22, 0x36, 0x2a, 0x2a, 0x22, 0x22, 0x22, 0x00, 0x00],
    //N
    [0x00, 0x00, 0x00, 0x22, 0x32, 0x2a, 0x26, 0x22, 0x22, 0x22, 0x00, 0x00],
    //O
    [0x00, 0x00, 0x00, 0x3e, 0x22, 0x22, 0x22, 0x22, 0x22, 0x3e, 0x00, 0x00],
    //P
    [0x00, 0x00, 0x00, 0x3c, 0x22, 0x22, 0x3c, 0x20, 0x20, 0x20, 0x00, 0x00],
    //Q
    [0x00, 0x00, 0x00, 0x1c, 0x22, 0x22, 0x22, 0x2a, 0x24, 0x1a, 0x00, 0x00],
    //R
    [0x00, 0x00, 0x00, 0x3c, 0x22, 0x22, 0x3c, 0x28, 0x24, 0x22, 0x00, 0x00],
    //S
    [0x00, 0x00, 0x00, 0x1c, 0x22, 0x10, 0x08, 0x04, 0x22, 0x1c, 0x00, 0x00],
    //T
    [0x00, 0x00, 0x00, 0x3e, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x00, 0x00],
    //U
    [0x00, 0x00, 0x00, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x1c, 0x00, 0x00],
    //V
    [0x00, 0x00, 0x00, 0x22, 0x22, 0x22, 0x14, 0x14, 0x08, 0x08, 0x00, 0x00],
    //W
    [0x00, 0x00, 0x00, 0x22, 0x22, 0x22, 0x2a, 0x2a, 0x36, 0x22, 0x00, 0x00],
    //X
    [0x00, 0x00, 0x00, 0x22, 0x22, 0x14, 0x08, 0x14, 0x22, 0x22, 0x00, 0x00],
    //Y
    [0x00, 0x00, 0x00, 0x22, 0x22, 0x14, 0x08, 0x08, 0x08, 0x08, 0x00, 0x00],
    //Z
    [0x00, 0x00, 0x00, 0x3e, 0x02, 0x04, 0x08, 0x10, 0x20, 0x3e, 0x00, 0x00],
    //[
    [0x00, 0x00, 0x00, 0x1c, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1c, 0x00, 0x00],
    //\
    [0x00, 0x00, 0x00, 0x20, 0x20, 0x10, 0x08, 0x04, 0x02, 0x02, 0x00, 0x00],
    //]
    [0x00, 0x00, 0x00, 0x1c, 0x04, 0x04, 0x04, 0x04, 0x04, 0x1c, 0x00, 0x00],
    //Up Arrow
    [0x00, 0x00, 0x00, 0x08, 0x1c, 0x2a, 0x08, 0x08, 0x08, 0x08, 0x00, 0x00],
    //Left Arrow
    [0x00, 0x00, 0x00, 0x08, 0x10, 0x3e, 0x10, 0x08, 0x00, 0x00, 0x00, 0x00],
    //Space
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    //!
    [0x00, 0x00, 0x00, 0x08, 0x08, 0x08, 0x08, 0x08, 0x00, 0x08, 0x00, 0x00],
    //"
    [0x00, 0x00, 0x00, 0x14, 0x14, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    //#
    [0x00, 0x00, 0x00, 0x14, 0x14, 0x36, 0x00, 0x36, 0x14, 0x14, 0x00, 0x00],
    //$
    [0x00, 0x00, 0x00, 0x08, 0x1e, 0x20, 0x1c, 0x02, 0x3c, 0x08, 0x00, 0x00],
    //%
    [0x00, 0x00, 0x00, 0x32, 0x32, 0x04, 0x08, 0x10, 0x26, 0x26, 0x00, 0x00],
    //&
    [0x00, 0x00, 0x00, 0x10, 0x28, 0x28, 0x10, 0x2a, 0x24, 0x1a, 0x00, 0x00],
    //'
    [0x00, 0x00, 0x00, 0x18, 0x18, 0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    //(
    [0x00, 0x00, 0x00, 0x04, 0x08, 0x10, 0x10, 0x10, 0x08, 0x04, 0x00, 0x00],
    //)
    [0x00, 0x00, 0x00, 0x10, 0x08, 0x04, 0x04, 0x04, 0x08, 0x10, 0x00, 0x00],
    //*
    [0x00, 0x00, 0x00, 0x00, 0x08, 0x1c, 0x3e, 0x1c, 0x08, 0x00, 0x00, 0x00],
    //+
    [0x00, 0x00, 0x00, 0x00, 0x08, 0x08, 0x3e, 0x08, 0x08, 0x00, 0x00, 0x00],
    //,
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x18, 0x18, 0x08, 0x10, 0x00, 0x00],
    //-
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3e, 0x00, 0x00, 0x00, 0x00, 0x00],
    //.
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x18, 0x18, 0x00, 0x00],
    ///
    [0x00, 0x00, 0x00, 0x02, 0x02, 0x04, 0x08, 0x10, 0x20, 0x20, 0x00, 0x00],
    //0
    [0x00, 0x00, 0x00, 0x18, 0x24, 0x24, 0x24, 0x24, 0x24, 0x18, 0x00, 0x00],
    //1
    [0x00, 0x00, 0x00, 0x08, 0x18, 0x08, 0x08, 0x08, 0x08, 0x1c, 0x00, 0x00],
    //2
    [0x00, 0x00, 0x00, 0x1c, 0x22, 0x02, 0x1c, 0x20, 0x20, 0x3e, 0x00, 0x00],
    //3
    [0x00, 0x00, 0x00, 0x1c, 0x22, 0x02, 0x0c, 0x02, 0x22, 0x1c, 0x00, 0x00],
    //4
    [0x00, 0x00, 0x00, 0x04, 0x0c, 0x14, 0x3e, 0x04, 0x04, 0x04, 0x00, 0x00],
    //5
    [0x00, 0x00, 0x00, 0x3e, 0x20, 0x3c, 0x02, 0x02, 0x22, 0x1c, 0x00, 0x00],
    //6
    [0x00, 0x00, 0x00, 0x1c, 0x20, 0x20, 0x3c, 0x22, 0x22, 0x1c, 0x00, 0x00],
    //7
    [0x00, 0x00, 0x00, 0x3e, 0x02, 0x04, 0x08, 0x10, 0x20, 0x20, 0x00, 0x00],
    //8
    [0x00, 0x00, 0x00, 0x1c, 0x22, 0x22, 0x1c, 0x22, 0x22, 0x1c, 0x00, 0x00],
    //9
    [0x00, 0x00, 0x00, 0x1c, 0x22, 0x22, 0x1c, 0x02, 0x02, 0x1c, 0x00, 0x00],
    //:
    [0x00, 0x00, 0x00, 0x00, 0x18, 0x18, 0x00, 0x18, 0x18, 0x00, 0x00, 0x00],
    //;
    [0x00, 0x00, 0x00, 0x18, 0x18, 0x00, 0x18, 0x18, 0x08, 0x10, 0x00, 0x00],
    //<
    [0x00, 0x00, 0x00, 0x04, 0x08, 0x10, 0x20, 0x10, 0x08, 0x04, 0x00, 0x00],
    //=
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x3e, 0x00, 0x3e, 0x00, 0x00, 0x00, 0x00],
    //>
    [0x00, 0x00, 0x00, 0x20, 0x10, 0x08, 0x04, 0x08, 0x10, 0x20, 0x00, 0x00],
    //?
    [0x00, 0x00, 0x00, 0x18, 0x24, 0x04, 0x08, 0x08, 0x00, 0x08, 0x00, 0x00]
]; //SG4CharacterSet

MC10.MC6847.Palette = [
    [0x28, 0xE0, 0x28], // CSS0 Green
    [0xF0, 0xF0, 0x70], // CSS0 Yellow
    [0x10, 0x10, 0xFE], // CSS0 Blue
    [0xF0, 0x30, 0x30], // CSS0 Red
    [0xF0, 0xF0, 0xF0], // CSS1 Buff
    [0x28, 0xA8, 0xA8], // CSS1 Cyan
    [0xF3, 0x61, 0xFA], // CSS1 Magenta
    [0xF0, 0x88, 0x28], // CSS1 Orange
    [0x00, 0x00, 0x00], // Black
    [0x10, 0x60, 0x10], // Dark  Green Text
    [0x78, 0x50, 0x20], // Dark  Orange Text
    [0x28, 0xE0, 0x28], // Light Green Text
    [0xF0, 0xB0, 0x40], // Light Orange Text
];

MC10.MC6847.prototype = {
    init: function () {
        this.graphicsMode = 0;
        this.palette = 0;

        this.audioNode = null;
        this.audioBuffer = null;
        this.toggleSpeaker = 0;
        this.abuf = new FiniteBuffer(100000); // really only need 41,000 samples for 60 Hz rate
        this.sampleRate = 48000;
        this.sample = 0;
        this.sampleValue = 0;
        this.vramIs4k = true;
        this.initAudioCtx();
    },

    initAudioCtx: function () {
        var self = this;
        if (this.audioCtx != null) {
            this.sampleRate = this.audioCtx.sampleRate;
            if (this.audioCtx.createScriptProcessor) {
                this.audioNode = this.audioCtx.createScriptProcessor(2048, 1, 1);
            } else {
                this.audioNode = this.audioCtx.createJavaScriptNode(2048, 1, 1);
            }
            this.audioNode.onaudioprocess = function (e) { self.processAudio(e); }
            this.audioNode.connect(this.audioCtx.destination);
        }
    },

    reset: function () {
        this.graphicsMode = 0;
        this.palette = 0;
        this.ctx.fillStyle = "black";
        this.ctx.fillRect(0, 0, 512, 384);
    },

    scaleImageData: function (imageData, scale) {
        var scaled = this.ctx.createImageData(imageData.width * scale, imageData.height * scale);
        for (var row = 0; row < imageData.height; row++) {
            for (var col = 0; col < imageData.width; col++) {
                var sourcePixel = [
                    imageData.data[(row * imageData.width + col) * 4 + 0],
                    imageData.data[(row * imageData.width + col) * 4 + 1],
                    imageData.data[(row * imageData.width + col) * 4 + 2],
                    imageData.data[(row * imageData.width + col) * 4 + 3]
                ];
                for (var y = 0; y < scale; y++) {
                    var destRow = row * scale + y;
                    for (var x = 0; x < scale; x++) {
                        var destCol = col * scale + x;
                        for (var i = 0; i < 4; i++) {
                            scaled.data[(destRow * scaled.width + destCol) * 4 + i] = sourcePixel[i];
                        }
                    }
                }
            }
        }
        return scaled;
    },

    paintFrame: function () {
        this.ctx.putImageData(this.imageData, 0, 0);
    },

    updateDisplay: function (pos, val) {
        // graphics modes
        // 8    64x64x4 (CG1)
        // 12   128x64x2 (RG1)
        // 10   128x64x4 (CG2)
        // 14   128x96x2 (RG2)
        // 9    128x96x4 (CG3)
        // 13   128x192x2 (RG3)
        // 11   128x192x4 (CG6)
        // 15   256x192x2 (RG6)
        if (this.graphicsMode < 8)
            this.updateSemiGraphics(pos, val);
        else if (this.graphicsMode < 12)
            this.updateColorGraphics(pos, val);
        else
            this.updateResolutionGraphics(pos, val);
    },

    updateResolutionGraphics: function (pos, val) {
        // graphics modes
        // 12   128x64x2 (RG1)
        // 14   128x96x2 (RG2)
        // 13   128x192x2 (RG3)
        // 15   256x192x2 (RG6)

        var pixPerByte = 8;
        var hPixSize = this.graphicsMode == 15 ? 2 : 4;
        var bytesPerRow = this.graphicsMode == 15 ? 32 : 16;
        var vPixSize = this.graphicsMode == 12 ? 6 :
            this.graphicsMode == 14 ? 4 :
                2;

        var screenX = (pos % bytesPerRow) * hPixSize * pixPerByte;
        var screenY = (pos - pos % bytesPerRow) / bytesPerRow * vPixSize;

        var data = this.imageData.data;
        var fgColor = this.palette ? 8 : 9; // black or dark green
        var bgColor = this.palette ? 4 : 0; // white or light green (matches background border pix)

        var tval = val & 0xff;

        for (var i = 0; i < pixPerByte; i++) {
            var color = tval & 0x80 ? bgColor : fgColor;
            tval <<= 1;
            for (var x = 0; x < hPixSize; x++) {
                for (var y = 0; y < vPixSize; y++) {
                    var idx0 = ((screenY + y) * 512 + screenX + x + i * hPixSize) * 4;
                    data[idx0] = MC10.MC6847.Palette[color][0];
                    data[idx0 + 1] = MC10.MC6847.Palette[color][1];
                    data[idx0 + 2] = MC10.MC6847.Palette[color][2];
                }
            }
        }
    },

    updateColorGraphics: function (pos, val) {
        // 8    64x64x4 (CG1)
        // 10   128x64x4 (CG2)
        // 9    128x96x4 (CG3)
        // 11   128x192x4 (CG6)

        var pixPerByte = 4;
        var hPixSize = this.graphicsMode == 8 ? 8 : 4;
        var bytesPerRow = this.graphicsMode == 8 ? 16 : 32;
        var vPixSize = this.graphicsMode == 11 ? 2 :
            this.graphicsMode == 9 ? 4 :
                6;

        var screenX = (pos % bytesPerRow) * hPixSize * pixPerByte;
        var screenY = (pos - pos % bytesPerRow) / bytesPerRow * vPixSize;

        var data = this.imageData.data;
        var tval = val & 0xff;
        var altcolor = this.palette ? 0x4 : 0x0;

        for (var i = 0; i < pixPerByte; i++) {
            var color = ((tval >> 6) & 0x03) | altcolor;
            tval <<= 2;
            for (var x = 0; x < hPixSize; x++) {
                for (var y = 0; y < vPixSize; y++) {
                    var idx0 = ((screenY + y) * 512 + screenX + x + i * hPixSize) * 4;
                    data[idx0] = MC10.MC6847.Palette[color][0];
                    data[idx0 + 1] = MC10.MC6847.Palette[color][1];
                    data[idx0 + 2] = MC10.MC6847.Palette[color][2];
                }
            }
        }
        this.setBorderColor(altcolor);
    },

    updateSemiGraphics: function (pos, val) {
        var screenX, screenY;
        var block = new Array(12);
        var fgColorIndex;
        var bgColorIndex;
        var color;

        if (val <= 0x7f) {
            bgColorIndex = 9 + this.palette + ((val & 0x40) >> 5);
            fgColorIndex = 11 + this.palette - ((val & 0x40) >> 5);

            for (var i = 0; i < 12; i++) {
                block[i] = this.graphicsMode & 1 ? val & 0x7f :
                    MC10.MC6847.SG4CharacterSet[val & 0x3f][i];
            }
        } else if (this.graphicsMode & 1) {
            bgColorIndex = 8;
            fgColorIndex = ((val & 0x40) >> 6) + (this.palette ? 6 : 2);

            for (var i = 0; i < 12; i++) {
                block[i] = MC10.MC6847.SG6Rectangle[val & 0x3f][i];
            }
        } else {
            bgColorIndex = 8;
            fgColorIndex = ((val & 0x70) >> 4);

            for (var i = 0; i < 12; i++) {
                block[i] = MC10.MC6847.SG4Rectangle[val & 0x0f][i];
            }
        }

        screenX = (pos % 32);
        screenY = ((pos - screenX) / 32);
        screenX *= 16;
        screenY *= 24;

        var data = this.imageData.data;

        for (var i = 0; i < 12; i++) {
            var cpos = 0x80;
            for (var j = 0; j < 8; j++) {
                if (block[i] & cpos) {
                    color = fgColorIndex;
                } else {
                    color = bgColorIndex;
                }
                for (var x = 0; x < 2; x++) {
                    for (var y = 0; y < 2; y++) {
                        var idx0 = ((screenY * 512) + (y * 512) + x + screenX) * 4;
                        data[idx0] = MC10.MC6847.Palette[color][0];
                        data[idx0 + 1] = MC10.MC6847.Palette[color][1];
                        data[idx0 + 2] = MC10.MC6847.Palette[color][2];
                    }
                }
                cpos >>= 1;
                screenX += 2;
            }
            screenX -= 16;
            screenY += 2;
        }

        this.setBorderColor(8); // black
    },

    getPaletteHexColor: function (color) {
        var r = MC10.MC6847.Palette[color][0];
        var g = MC10.MC6847.Palette[color][1];
        var b = MC10.MC6847.Palette[color][2];
        var value = 1 << 24 | r << 16 | g << 8 | b;

        return '#' + value.toString(16).substring(1);
    },

    setBorderColor: function (color) {
        this.screen.style.borderColor = this.getPaletteHexColor(color);
    },

    processAudio: function (e) {
        var data = e.outputBuffer.getChannelData(0);
        var abufRate = this.mc10.clockRate;
        var cutoffFreq = 8000; // 8 kHz cutoff
        var droop = Math.exp(-cutoffFreq / abufRate);
        var sampleValue = this.sampleValue;

        var iData = 0;
        var iBuf = 0;

        while (this.abuf.length > 0) {
            var bufValue = this.abuf.pull() != 0 ? 0.1 : 0;
            sampleValue = (sampleValue - bufValue) * droop + bufValue;
            iData = Math.floor(iBuf++ * this.sampleRate / abufRate);
            if (iData < data.length)
                data[iData] = sampleValue;
            else
                break;
        }

        while (iData < data.length) {
            data[iData] = sampleValue;
            ++iData;
        }

        this.sampleValue = sampleValue;
    },

    updateAudio: function () {
        this.abuf.push(this.toggleSpeaker);
    },

    updateChip: function (val) {
        this.toggleSpeaker = (val & 0x80);

        var dirty = false;
        var mode = this.graphicsMode;
        this.graphicsMode = ((val >> 2) & 0xf);
        if (mode != this.graphicsMode) {
            dirty = true;
        }
        var pal = this.palette;
        this.palette = (val >> 6) & 0x01;
        if (pal != this.palette) {
            dirty = true;
        }
        return dirty;
    }
}

MC10.KBD = function (mc10) {
    this.mc10 = mc10;
    this.textBuffer = new Uint8Array(0);
    this.textIndex = 0;
    this.patchROM = false;
    //this.init();
};

MC10.KBD.prototype = {

    init: function () {
        var self = this;
        window.onkeyup = function (evt) { self.keyUp(evt); };
        window.onkeydown = function (evt) { self.keyDown(evt); };
        window.onkeypress = function (evt) { self.keyPress(evt) };
    },

    keyUp: function (evt) {
        var ks = evt.keyCode;

        if (ks >= 65 && ks <= 90) {
            this.mc10.cpu.port1[ks % 8] |= (1 << ((ks - 64) / 8));
        } else if (ks == 13) {
            this.mc10.cpu.port1[6] |= (1 << 3);
        } else if (ks == 16) { // Shift
            this.mc10.cpu.port2[7] |= (0x02);
        } else if (ks == 17) { // Ctrl
            this.mc10.cpu.port2[0] |= (0x02);
        } else if (ks == 27) { // Break
            this.mc10.cpu.port2[2] |= (0x02);
        } else if (ks == 32) {
            this.mc10.cpu.port1[7] |= (1 << 3);
        } else if (ks >= 48 && ks <= 55) {
            this.mc10.cpu.port1[ks - 48] |= (1 << 4);
        } else if (ks == 189 || ks == 109) {
            this.mc10.cpu.port1[2] |= (1 << 5);
        } else if (ks == 187 || ks == 107) {
            this.mc10.cpu.port1[5] |= (1 << 5);
        } else if (ks == 219) {
            this.mc10.cpu.port1[0] |= (1 << 0);
        } else if (ks >= 56 && ks <= 185) {
            this.mc10.cpu.port1[ks - 56] |= (1 << 5);
        } else if (ks == 186) { // +
            this.mc10.cpu.port1[3] |= (1 << 5);
        } else if (ks == 188) { // ,
            this.mc10.cpu.port1[4] |= (1 << 5);
        } else if (ks >= 190 && ks <= 191) { // ./
            this.mc10.cpu.port1[ks - 184] |= (1 << 5);
        } else if (ks == 226 || ks == 225) {
            this.mc10.cpu.port2[7] |= (0x02);
        } else if (ks == 255) {
            this.mc10.cpu.port2[2] |= (0x02);
        } else if (ks == 8) { // Simulate Ctrl-A
            this.mc10.cpu.port2[0] |= (0x02);
            this.mc10.cpu.port1[1] |= (0x01);
        } else {
            console.debug("Unrecognized keycode: " + ks);
        }
    },

    keyDown: function (evt) {
        var ks = evt.keyCode;

        if (ks >= 65 && ks <= 90) {
            this.mc10.cpu.port1[ks % 8] &= ~(1 << ((ks - 64) / 8)); // A - Z
        } else if (ks == 13) {
            this.mc10.cpu.port1[6] &= ~(1 << 3);
        } else if (ks == 16) { // Shift
            this.mc10.cpu.port2[7] &= ~(0x02);
        } else if (ks == 17) { // Ctrl
            this.mc10.cpu.port2[0] &= ~(0x02);
        } else if (ks == 27) { // Break
            this.mc10.cpu.port2[2] &= ~(0x02);
        } else if (ks == 32) {
            this.mc10.cpu.port1[7] &= ~(1 << 3);
        } else if (ks >= 48 && ks <= 55) {
            this.mc10.cpu.port1[ks - 48] &= ~(1 << 4);
        } else if (ks == 189 || ks == 109) {
            this.mc10.cpu.port1[2] &= ~(1 << 5);
        } else if (ks == 187 || ks == 107) {
            this.mc10.cpu.port1[5] &= ~(1 << 5);
        } else if (ks == 219) {
            this.mc10.cpu.port1[0] &= ~(1 << 0);
        } else if (ks >= 56 && ks <= 185) {
            this.mc10.cpu.port1[ks - 56] &= ~(1 << 5);
        } else if (ks == 186) { // +
            this.mc10.cpu.port1[3] &= ~(1 << 5);
        } else if (ks == 188) { // ,
            this.mc10.cpu.port1[4] &= ~(1 << 5);
        } else if (ks >= 190 && ks <= 191) { // ./
            this.mc10.cpu.port1[ks - 184] &= ~(1 << 5);
        } else if (ks == 226 || ks == 225) {
            this.mc10.cpu.port2[7] &= ~(0x02);
        } else if (ks == 255) {
            this.mc10.cpu.port2[2] &= ~(0x02);
        } else if (ks == 8) { // Simulate Ctrl-A
            this.mc10.cpu.port2[0] &= ~(0x02);
            this.mc10.cpu.port1[1] &= ~(0x01);
        } else {
            console.debug("Unrecognized keycode: " + ks);
        }
        //evt.preventDefault();
        //evt.stopPropagation();
        this.mc10.vdg.audioCtx.resume(); // https://goo.gl/7K7WLu
        return false;
    },

    keyPress: function (evt) {

    },

    quicktype: function (textdata) {
        this.textBuffer = new Uint8Array(textdata);
        this.textIndex = 0;
        this.patchROM = true;
        console.log('entering ' + this.textBuffer.length + ' text characters.');
    },

    quickread: function () {
        var byte = this.textBuffer[this.textIndex++] & 0xff;

        if (this.textIndex >= this.textBuffer.length) {
            this.patchROM = false;
            this.quickstop();
        }

        return byte == 10 ? 13 :
            byte == 13 ? 0 :
                byte;
    },

    quickstop: function () {
        console.log('text entered.');
        if (this.mc10.playbackFinishedCallback !== undefined) {
            this.mc10.playbackFinishedCallback();
        }
    },

    reset: function () {
        this.patchROM = false;
        this.textIndex = 0;
    }
}

MC10.Cassette = function (mc10) {
    this.mc10 = mc10;
}

MC10.Cassette.prototype = {
    init: function() {
        this.recording = false;
        this.sampleRate = 44100;
        this.sampleBuffer = new Float32Array(0);
        this.sampleTime = 0;
        this.c10buffer = new Array(0);
        this.patchROM = false;
    },

    playWav: function (sampleRate, pcmSamples) {
        console.log("loading " + pcmSamples.length + " samples at " + sampleRate + " Hz")
        this.sampleRate = sampleRate;
        this.sampleBuffer = pcmSamples.slice();
        this.sampleTime = 0;
        this.acfilter();
    },

    acfilter: function () {
        var lastLevel = 0;
        var droop = Math.exp(-100 / this.sampleRate);
        for (var i = 0; i < this.sampleBuffer.length; i++) {
            lastLevel = droop * (this.sampleBuffer[i] - lastLevel) + lastLevel;
            this.sampleBuffer[i] -= lastLevel;
        }
    },

    advance: function (numCycles) {
        this.sampleTime += numCycles / this.mc10.clockRate;
        var bufferLen = this.sampleBuffer.length;
        var sampleValue = 0;
        if (bufferLen > 0) {
            var index = Math.round(this.sampleTime * this.sampleRate);
            if (index < bufferLen) {
                sampleValue = this.sampleBuffer[index];
            } else {
                this.sampleBuffer = new Float32Array(0);
                this.stop();
            }
        }
        if (sampleValue > 0) {
            this.mc10.cpu.port2[4] = 0xff;
        } else {
            this.mc10.cpu.port2[4] = 0xef;
        }
    },

    // callback function for stop event
    stop: function () {
        console.log("C10 playback stopped");
        if (this.mc10.playbackFinishedCallback !== undefined) {
            this.mc10.playbackFinishedCallback();
        }
    },

    playC10: function (c10data) {
        this.c10data = new Uint8Array(c10data);
        this.c10bitsRemaining = 0;
        this.c10byte = 0;
        this.c10index = 0;
        this.patchROM = true;
        this.recording = false;
        console.log('loading ' + this.c10data.length + ' raw bytes.')
    },

    getC10bit: function () {
        var bit = 0;
        if (this.c10bitsRemaining == 0) {
            if (this.c10index < this.c10data.length) {
                this.c10byte = this.c10data[this.c10index++];
                bit = this.c10byte & 1;
                this.c10byte >>= 1;
                this.c10bitsRemaining = 7;
            } else {
                this.patchROM = false;
                this.stop();
            }
        } else {
            bit = this.c10byte & 1;
            this.c10byte >>= 1;
            this.c10bitsRemaining--;
        }

        return bit;
    },

    recordC10: function (autostop) {
        this.patchROM = true;
        this.recording = true;
        this.autoStop = autostop;
        this.recBuffer = new Uint8Array(0xffff + 1);
        this.recIndex = 0;
    },

    recordC10byte: function (byte) {
        this.recBuffer[this.recIndex] = byte;
        this.recIndex = (this.recIndex + 1) & 0xffff;
    },

    saveRecord: function () {
        this.patchROM = false;
        this.recording = false;
        this.autoStop(this.recBuffer.slice(0, this.recIndex));
    },

    reset: function () {
        this.patchROM = false;
        this.recording = false;
        this.recIndex = 0;
    }
}