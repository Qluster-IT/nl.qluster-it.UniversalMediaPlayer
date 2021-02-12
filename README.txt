# Device Capabilities

Set capabilities of device's per zone, for example open or close all curtains in a certain zone, including (or not) the subzones.
Also listen for capabilities of which there are no triggers from the app developer.

Trigger
* You can listen to capability changes.
  Add an If card, search the Device in the first field, then enter the same Device name in the second field. Now choose a capability from the list.
  Example: Capability listener


Actions
* You can set any (well almost right now) capability for device's in a zone (and ther subzones if wanted).
  Add a Then card, choose the capability in the first field followed by the value in the second field. Then choose a zone and if the subzones should be included.
  Example: Set curtain.windowcoverings_set To 0 in Home including subzones (Yes).
  This will close all curtains in the Home and subzones. Setting it to 1 will open all curtains.