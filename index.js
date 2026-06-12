let Service, Characteristic;

const packageJson = require("./package.json");
const jp = require("jsonpath");

const fetch = global.fetch || require("node-fetch");

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    homebridge.registerAccessory(
        "homebridge-garage-door-http",
        "GarageDoorOpener",
        GarageDoorOpener
    );
};

// ---------------- STATE MODEL ----------------

const STATES = {
    OPEN: "OPEN",
    CLOSED: "CLOSED",
    OPENING: "OPENING",
    CLOSING: "CLOSING",
    UNKNOWN: "UNKNOWN"
};

function GarageDoorOpener(log, config) {
    this.log = log;
    this.config = config;

    this.name = config.name;

    this.openURL = config.openURL;
    this.closeURL = config.closeURL;

    this.statusURL = config.statusURL;
    this.statusKey = config.statusKey || "$.inputs[0].input";

    this.statusValueOpen = config.statusValueOpen || "0";
    this.statusValueClosed = config.statusValueClosed || "1";

    this.http_method = config.http_method || "GET";
    this.timeout = config.timeout || 3000;

    this.polling = config.polling || true;
    this.pollInterval = config.pollInterval || 10;

    // internal state
    this.state = STATES.UNKNOWN;
    this.intent = null; // OPEN or CLOSED
    this.movementTimer = null;
    this.pollTimer = null;

    this.service = null;
}

// ---------------- HTTP ----------------

GarageDoorOpener.prototype._httpRequest = function (url, body, cb) {
    fetch(url, {
        method: this.http_method,
        body: body || undefined,
        signal: AbortSignal.timeout(this.timeout)
    })
        .then(r => r.text().then(t => cb(null, t)))
        .catch(cb);
};

// ---------------- SENSOR ----------------

GarageDoorOpener.prototype._readSensor = function (cb) {
    this._httpRequest(this.statusURL, "", (err, body) => {
        if (err) return cb(err);

        try {
            const json = JSON.parse(body);
            const raw = jp.query(json, this.statusKey).pop();

            if (new RegExp(this.statusValueOpen).test(raw)) return cb(null, STATES.OPEN);
            if (new RegExp(this.statusValueClosed).test(raw)) return cb(null, STATES.CLOSED);

            return cb(null, STATES.UNKNOWN);
        } catch (e) {
            cb(e);
        }
    });
};

// ---------------- STATE ENGINE ----------------

GarageDoorOpener.prototype._applyState = function (next, source = "system") {
    const prev = this.state;
    this.state = next;

    let hk;

    switch (next) {
        case STATES.OPEN:
            hk = Characteristic.CurrentDoorState.OPEN;
            break;
        case STATES.CLOSED:
            hk = Characteristic.CurrentDoorState.CLOSED;
            break;
        case STATES.OPENING:
            hk = Characteristic.CurrentDoorState.OPENING;
            break;
        case STATES.CLOSING:
            hk = Characteristic.CurrentDoorState.CLOSING;
            break;
        default:
            hk = Characteristic.CurrentDoorState.STOPPED;
    }

    this.service.updateCharacteristic(
        Characteristic.CurrentDoorState,
        hk
    );

    // Only sync target when we are in stable sensor state
    if (next === STATES.OPEN || next === STATES.CLOSED) {
        this.service.updateCharacteristic(
            Characteristic.TargetDoorState,
            next === STATES.OPEN
                ? Characteristic.TargetDoorState.OPEN
                : Characteristic.TargetDoorState.CLOSED
        );

        this.intent = null;
    }

    if (this.config.debug) {
        this.log.debug(`[STATE] ${prev} → ${next} (${source})`);
    }
};

// ---------------- SENSOR SYNC (TRUTH LOOP) ----------------

GarageDoorOpener.prototype._sync = function () {
    this._readSensor((err, sensorState) => {
        if (err) return;

        // deterministic override rules
        if (this.state === STATES.OPENING || this.state === STATES.CLOSING) {
            // if sensor disagrees, override immediately
            if (sensorState === STATES.OPEN || sensorState === STATES.CLOSED) {
                this._applyState(sensorState, "sensor-override");
            }
            return;
        }

        if (sensorState !== STATES.UNKNOWN) {
            this._applyState(sensorState, "sensor");
        }
    });
};

// ---------------- COMMAND ----------------

GarageDoorOpener.prototype.setTargetDoorState = function (value, cb) {
    const desired = value === 0 ? STATES.OPEN : STATES.CLOSED;

    // already correct
    if (this.state === desired) return cb();

    this.intent = desired;

    const url = desired === STATES.OPEN ? this.openURL : this.closeURL;

    // enter movement state immediately
    this._applyState(
        desired === STATES.OPEN ? STATES.OPENING : STATES.CLOSING,
        "command"
    );

    this._httpRequest(url, "", (err) => {
        if (err) {
            this.log.warn("Command failed: %s", err.message);
            return cb(err);
        }

        // start polling until sensor confirms
        this._startPolling();
        cb();
    });
};

// ---------------- POLLING (DETERMINISTIC RESOLUTION) ----------------

GarageDoorOpener.prototype._startPolling = function () {
    if (this.pollTimer) clearInterval(this.pollTimer);

    this.pollTimer = setInterval(() => {
        this._readSensor((err, sensorState) => {
            if (err) return;

            if (
                this.intent === STATES.OPEN &&
                sensorState === STATES.OPEN
            ) {
                clearInterval(this.pollTimer);
                this._applyState(STATES.OPEN, "sensor-final");
            }

            if (
                this.intent === STATES.CLOSED &&
                sensorState === STATES.CLOSED
            ) {
                clearInterval(this.pollTimer);
                this._applyState(STATES.CLOSED, "sensor-final");
            }
        });
    }, this.pollInterval * 1000);
};

// ---------------- HOMEKIT ----------------

GarageDoorOpener.prototype.getServices = function () {
    this.informationService = new Service.AccessoryInformation();

    this.informationService
        .setCharacteristic(Characteristic.Manufacturer, "Garage HTTP")
        .setCharacteristic(Characteristic.Model, packageJson.name)
        .setCharacteristic(Characteristic.SerialNumber, packageJson.version);

    this.service = new Service.GarageDoorOpener(this.name);

    this.service
        .getCharacteristic(Characteristic.TargetDoorState)
        .on("set", this.setTargetDoorState.bind(this));

    // initial sync
    this._sync();

    if (this.polling) {
        setInterval(() => this._sync(), this.pollInterval * 1000);
    }

    return [this.informationService, this.service];
};