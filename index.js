let Service, Characteristic;

const jp = require("jsonpath");
const fetch = global.fetch || require("node-fetch");

const STATE = {
    IDLE: "IDLE",
    OPENING: "OPENING",
    CLOSING: "CLOSING",
    OPEN: "OPEN",
    CLOSED: "CLOSED",
    SYNCING: "SYNCING"
};

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    homebridge.registerAccessory(
        "homebridge-garage-door-http",
        "GarageDoorOpener",
        GarageDoorOpener
    );
};

function GarageDoorOpener(log, config) {
    this.log = log;

    this.name = config.name;

    this.openURL = config.openURL;
    this.closeURL = config.closeURL;

    this.statusURL = config.statusURL;
    this.statusKey = config.statusKey || "state";

    this.statusValueOpen = config.statusValueOpen || "OPEN";
    this.statusValueClosed = config.statusValueClosed || "CLOSED";

    this.pollInterval = (config.pollInterval || 5) * 1000;

    this.transitionTime = config.transitionTime
        ? config.transitionTime * 1000
        : this.pollInterval;

    this.http_method = config.http_method || "GET";
    this.timeout = config.timeout || 3000;

    this.service = null;

    this.state = STATE.IDLE;

    this.log.warn(`[${this.name}] created`);
}

// ---------- Helper functions

GarageDoorOpener.prototype._isOpen = function (raw) {
    return raw === this.statusValueOpen;
};

GarageDoorOpener.prototype._isClosed = function (raw) {
    return raw === this.statusValueClosed;
};

// ---- Poll Loop

GarageDoorOpener.prototype.pollLoop = function () {
    if (this.state === STATE.OPENING || this.state === STATE.CLOSING) {
        // skip sensor during transitions
    } else {
        this._syncSensor();
    }

    setTimeout(() => {
        this.pollLoop();
    }, this.pollInterval);
};

// ---------------- HTTP ----------------

GarageDoorOpener.prototype._http = function (url, cb) {
    fetch(url, {
        method: this.http_method,
        signal: AbortSignal.timeout(this.timeout)
    })
        .then(r => r.text().then(t => cb(null, t)))
        .catch(cb);
};

// ---------------- SENSOR = SOURCE OF TRUTH ----------------

GarageDoorOpener.prototype._syncSensor = function () {

    this.state = STATE.SYNCING;

    this._http(this.statusURL, (err, body) => {

        if (err) {
            this.log.warn("Sensor HTTP error:", err.message);
            return;
        }

        try {
            const json = JSON.parse(body);
            const raw = jp.query(json, this.statusKey).pop();

            let current;
            let target;

            if (this._isOpen(raw)) {

                current = Characteristic.CurrentDoorState.OPEN;
                target = Characteristic.TargetDoorState.OPEN;
                this.state = STATE.OPEN;

            } else if (this._isClosed(raw)) {

                current = Characteristic.CurrentDoorState.CLOSED;
                target = Characteristic.TargetDoorState.CLOSED;
                this.state = STATE.CLOSED;

            } else {
                this.state = STATE.IDLE;
                return;
            }

            this.service.updateCharacteristic(
                Characteristic.CurrentDoorState,
                current
            );

            this.service.updateCharacteristic(
                Characteristic.TargetDoorState,
                target
            );

        } catch (e) {
            this.log.warn("Sensor error", e);
        }
    });
};

// ---------------- COMMAND ONLY ----------------

GarageDoorOpener.prototype.setTargetDoorState = function (value, callback) {

    const isOpen = value === Characteristic.TargetDoorState.OPEN;
    const url = isOpen ? this.openURL : this.closeURL;

    const current = this.service.getCharacteristic(
        Characteristic.CurrentDoorState
    ).value;

    // Ignore redundant commands
    if (isOpen && current === Characteristic.CurrentDoorState.OPEN) {
        return callback();
    }

    if (!isOpen && current === Characteristic.CurrentDoorState.CLOSED) {
        return callback();
    }

    // Transition state for HomeKit UI
    this.state = isOpen ? STATE.OPENING : STATE.CLOSING;

    this.service.updateCharacteristic(
        Characteristic.CurrentDoorState,
        isOpen
            ? Characteristic.CurrentDoorState.OPENING
            : Characteristic.CurrentDoorState.CLOSING
    );

    this.log.warn(`[${this.name}] ${this.state}`);

    this._http(url, (err) => {

        if (err) {
            this.log.warn("Command failed:", err.message);
            this.state = STATE.IDLE;
            return callback(err);
        }

        setTimeout(() => {
            this._syncSensor();
        }, this.transitionTime);

        callback();
    });
};

// ---------------- HOMEKIT ----------------

GarageDoorOpener.prototype.getServices = function () {

    this.informationService = new Service.AccessoryInformation();

    this.informationService
        .setCharacteristic(Characteristic.Manufacturer, "Garage HTTP")
        .setCharacteristic(Characteristic.Model, "State Machine")
        .setCharacteristic(Characteristic.SerialNumber, "1.0");

    this.service = new Service.GarageDoorOpener(this.name);

    this.service
        .getCharacteristic(Characteristic.TargetDoorState)
        .on("set", this.setTargetDoorState.bind(this));

    this._syncSensor();
    this.pollLoop();

    this.log.warn(`[${this.name}] polling started`);

    return [this.informationService, this.service];
};