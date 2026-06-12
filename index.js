let Service, Characteristic;

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

    this.service = null;
}

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
    this._http(this.config.statusURL, (err, body) => {
        if (err) return;

        try {
            const json = JSON.parse(body);
            const raw = jp.query(json, this.statusKey).pop();

            let current;

            if (new RegExp(this.statusValueOpen).test(raw)) {
                current = Characteristic.CurrentDoorState.OPEN;
            } else if (new RegExp(this.statusValueClosed).test(raw)) {
                current = Characteristic.CurrentDoorState.CLOSED;
            } else {
                return;
            }

            // 1. ALWAYS set current state
            this.service.updateCharacteristic(
                Characteristic.CurrentDoorState,
                current
            );

            // 2. CRITICAL: ALWAYS force target sync too
            this.service.updateCharacteristic(
                Characteristic.TargetDoorState,
                current === Characteristic.CurrentDoorState.OPEN
                    ? Characteristic.TargetDoorState.OPEN
                    : Characteristic.TargetDoorState.CLOSED
            );

        } catch (e) {
            this.log.warn("Sensor error", e);
        }
    });
};

// ---------------- COMMAND ONLY ----------------

GarageDoorOpener.prototype.setTargetDoorState = function (value, callback) {
    const url = value === 0 ? this.openURL : this.closeURL;

    this._http(url, (err) => {
        if (err) {
            this.log.warn("Command failed:", err.message);
            return callback(err);
        }

        // IMPORTANT:
        // do NOT set any state here
        // sensor will correct everything
        callback();
    });
};

// ---------------- HOMEKIT ----------------

GarageDoorOpener.prototype.getServices = function () {
    this.informationService = new Service.AccessoryInformation();

    this.informationService
        .setCharacteristic(Characteristic.Manufacturer, "Garage HTTP")
        .setCharacteristic(Characteristic.Model, "Sensor-driven")
        .setCharacteristic(Characteristic.SerialNumber, "1.0");

    this.service = new Service.GarageDoorOpener(this.name);

    this.service
        .getCharacteristic(Characteristic.TargetDoorState)
        .on("set", this.setTargetDoorState.bind(this));

    // initial sync
    this._syncSensor();

    // optional light polling (you still need *some* refresh mechanism)
    setInterval(() => this._syncSensor(), 5000);

    return [this.informationService, this.service];
};