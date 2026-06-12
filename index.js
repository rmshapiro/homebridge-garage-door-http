let Service, Characteristic;

const packageJson = require("./package.json");
const jp = require("jsonpath");

// Safe fetch for Homebridge environments
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

function GarageDoorOpener(log, config) {
    this.log = log;
    this.config = config;

    this.name = config.name;

    this.openURL = config.openURL;
    this.closeURL = config.closeURL;

    this.openTime = config.openTime || 10;
    this.closeTime = config.closeTime || 10;

    this.polling = config.polling || false;
    this.pollInterval = config.pollInterval || 120;
    this.movementPollInterval = config.movementPollInterval || 2;

    this.statusURL = config.statusURL;
    this.statusKey = config.statusKey || "$.inputs[0].input";

    this.statusValueOpen = config.statusValueOpen || "0";
    this.statusValueClosed = config.statusValueClosed || "1";

    this.http_method = config.http_method || "GET";

    this.timeout = config.timeout || 3000;

    this.state = "UNKNOWN";
    this.movementToken = 0;

    this.pollTimer = null;
    this.timeoutTimer = null;
    this.pollTimerGlobal = null;

    this.service = null;
}

/* -------------------------
   HTTP
--------------------------*/
GarageDoorOpener.prototype._httpRequest = function (url, body, callback) {
    fetch(url, {
        method: this.http_method,
        body: body || undefined,
        signal: AbortSignal.timeout(this.timeout)
    })
        .then(async (res) => {
            const text = await res.text();
            callback(null, res, text);
        })
        .catch((err) => callback(err));
};

/* -------------------------
   SENSOR STATUS
--------------------------*/
GarageDoorOpener.prototype._fetchStatus = function (callback) {
    this._httpRequest(this.statusURL, "", (error, response, body) => {
        if (error) return callback(error);

        try {
            const json = typeof body === "string" ? JSON.parse(body) : body;

            const raw = jp.query(json, this.statusKey).pop();

            let value = -1;
            if (new RegExp(this.statusValueOpen).test(raw)) value = 0;
            else if (new RegExp(this.statusValueClosed).test(raw)) value = 1;

            callback(null, value);
        } catch (e) {
            callback(e);
        }
    });
};

/* -------------------------
   STATE SETTER
--------------------------*/
GarageDoorOpener.prototype._setState = function (state, source = "internal") {
    this.state = state;

    let hkState;

    switch (state) {
        case "OPEN":
            hkState = Characteristic.CurrentDoorState.OPEN;
            break;
        case "CLOSED":
            hkState = Characteristic.CurrentDoorState.CLOSED;
            break;
        case "OPENING":
            hkState = Characteristic.CurrentDoorState.OPENING;
            break;
        case "CLOSING":
            hkState = Characteristic.CurrentDoorState.CLOSING;
            break;
        default:
            return;
    }

    this.service.updateCharacteristic(
        Characteristic.CurrentDoorState,
        hkState
    );

    // sync target on confirmed sensor state
    if (source === "sensor" || source === "sensor-final") {
        this.service.updateCharacteristic(
            Characteristic.TargetDoorState,
            state === "OPEN"
                ? Characteristic.TargetDoorState.OPEN
                : Characteristic.TargetDoorState.CLOSED
        );

        this.movementToken++;
    }

    if (this.config.debug) {
        this.log.debug(`STATE => ${state} (${source})`);
    }
};

/* -------------------------
   SENSOR SYNC
--------------------------*/
GarageDoorOpener.prototype._syncFromSensor = function () {
    if (this.state === "OPENING" || this.state === "CLOSING") return;

    this._fetchStatus((err, value) => {
        if (err) return;

        if (value === 0) this._setState("OPEN", "sensor");
        if (value === 1) this._setState("CLOSED", "sensor");
    });
};

/* -------------------------
   COMMAND
--------------------------*/
GarageDoorOpener.prototype.setTargetDoorState = function (value, callback) {
    const desired = value === 0 ? "OPEN" : "CLOSED";

    if (
        (desired === "OPEN" && this.state === "OPEN") ||
        (desired === "CLOSED" && this.state === "CLOSED")
    ) {
        this.log.debug("%s requested but already in state %s", desired, this.state);
        return callback();
    }

    this.movementToken++;
    const token = this.movementToken;

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);

    this._setState(desired === "OPEN" ? "OPENING" : "CLOSING", "command");

    const url = value === 1 ? this.closeURL : this.openURL;

    this._httpRequest(url, "", (error) => {
        if (error) {
            this.log.warn("Command error: %s", error.message);
            return callback(error);
        }

        this.service.updateCharacteristic(
            Characteristic.TargetDoorState,
            value
        );

        this._startMovementMonitor(desired, token);
        callback();
    });
};

/* -------------------------
   MOVEMENT MONITOR
--------------------------*/
GarageDoorOpener.prototype._startMovementMonitor = function (desired, token) {
    const targetState = desired;

    this.pollTimer = setInterval(() => {
        if (token !== this.movementToken) return;

        this._fetchStatus((err, value) => {
            if (err) return;

            const reached =
                (targetState === "OPEN" && value === 0) ||
                (targetState === "CLOSED" && value === 1);

            if (reached) {
                clearInterval(this.pollTimer);
                clearTimeout(this.timeoutTimer);

                this._setState(targetState, "sensor-final");

                this.service.updateCharacteristic(
                    Characteristic.TargetDoorState,
                    targetState === "OPEN"
                        ? Characteristic.TargetDoorState.OPEN
                        : Characteristic.TargetDoorState.CLOSED
                );
            }
        });
    }, this.movementPollInterval * 1000);

    this.timeoutTimer = setTimeout(() => {
        if (token !== this.movementToken) return;

        clearInterval(this.pollTimer);

        this.log.warn("Movement timeout → resyncing sensor");

        this._syncFromSensor();
    }, (desired === "OPEN" ? this.openTime : this.closeTime) * 1000);
};

/* -------------------------
   IDENTIFY
--------------------------*/
GarageDoorOpener.prototype.identify = function (callback) {
    this.log("Identify requested");
    callback();
};

/* -------------------------
   SERVICES
--------------------------*/
GarageDoorOpener.prototype.getServices = function () {
    this.informationService = new Service.AccessoryInformation();

    this.informationService
        .setCharacteristic(Characteristic.Manufacturer, this.config.manufacturer || "Garage HTTP")
        .setCharacteristic(Characteristic.Model, packageJson.name)
        .setCharacteristic(Characteristic.SerialNumber, packageJson.version);

    this.service = new Service.GarageDoorOpener(this.name);

    this.service
        .getCharacteristic(Characteristic.TargetDoorState)
        .on("set", this.setTargetDoorState.bind(this));

    // initialize safe state
    this.service
        .getCharacteristic(Characteristic.CurrentDoorState)
        .updateValue(Characteristic.CurrentDoorState.CLOSED);

    if (this.polling) {
        this._syncFromSensor();

        this.pollTimerGlobal = setInterval(() => {
            this._syncFromSensor();
        }, this.pollInterval * 1000);
    }

    return [this.informationService, this.service];
};